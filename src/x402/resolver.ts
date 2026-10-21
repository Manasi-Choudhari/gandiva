import { resolveUnknownWithdrawals } from "../agents/wallet.js";
import { fromUnits } from "../config.js";
import { log } from "../log.js";
import { workerTick } from "../workers.js";
import { listAuditable, listUnconfirmed, resolveLedger } from "../registry/store.js";
import { chainTime, lookupAuthorization, type AuthRef } from "./chain.js";

const authOf = (row: any): AuthRef => ({ from: row.auth_from, nonce: row.auth_nonce, validBefore: Number(row.valid_before), signedAt: Number(row.signed_at) });

export interface ResolveSummary {
  checked: number;
  paid: number;
  notCharged: number;
  stillOpen: number;
}

/**
 * Settles ledger rows whose outcome we could not see: a payment signed and sent, but the answer never came back.
 * The chain is the source of truth. A consumed authorisation nonce means USDC moved (-> paid, with the tx hash);
 * an unconsumed one past its validBefore can never move money any more (-> failed, not charged).
 * Rows recorded as "not charged" are re-checked until validBefore has passed, in case a seller settled late.
 */
export async function resolveUnconfirmed(): Promise<ResolveSummary> {
  const summary: ResolveSummary = { checked: 0, paid: 0, notCharged: 0, stillOpen: 0 };
  const open = listUnconfirmed();
  const auditable = listAuditable(Math.floor(Date.now() / 1000));
  if (!open.length && !auditable.length) return summary;
  const now = await chainTime();

  for (const row of open) {
    summary.checked++;
    if (!row.auth_nonce) {
      // Nothing to look up: keep it visible rather than guess.
      summary.stillOpen++;
      continue;
    }
    try {
      const out = await lookupAuthorization(authOf(row), now);
      if (out.state === "used") {
        resolveLedger(row.id, { status: "paid", paid: out.amount.toString(), txHash: out.txHash, reason: `resolved from chain: authorisation was settled (${fromUnits(out.amount)} USDC)` });
        summary.paid++;
      } else if (out.state === "unused" && out.expired) {
        resolveLedger(row.id, { status: "failed_not_charged", paid: "0", reason: "resolved from chain: authorisation expired unused, no USDC moved" });
        summary.notCharged++;
      } else summary.stillOpen++;
    } catch (err: any) {
      summary.stillOpen++;
      log("warn", "resolver: lookup failed", { ledgerId: row.id, error: String(err?.shortMessage ?? err?.message ?? err).slice(0, 160) });
    }
  }

  for (const row of auditable) {
    try {
      const out = await lookupAuthorization(authOf(row), now);
      if (out.state === "used") {
        const fixed = resolveLedger(
          row.id,
          { status: "paid", paid: out.amount.toString(), txHash: out.txHash, reason: "seller reported failure but settled the authorisation on-chain; corrected from chain" },
          ["failed_not_charged"],
        );
        if (fixed) summary.paid++;
      }
    } catch (err: any) {
      log("warn", "resolver: audit failed", { ledgerId: row.id, error: String(err?.shortMessage ?? err?.message ?? err).slice(0, 160) });
    }
  }
  return summary;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Background watcher: runs the resolver on an interval so unconfirmed rows settle without anyone clicking anything. */
export function startResolver(intervalMs = 15_000) {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await resolveUnconfirmed();
      if (s.paid || s.notCharged) log("info", "resolver: settled", { paid: s.paid, notCharged: s.notCharged, stillOpen: s.stillOpen });
      const w = await resolveUnknownWithdrawals();
      if (w) log("info", "resolver: settled withdrawals of unknown outcome", { withdrawals: w });
      workerTick("resolver");
    } catch (err: any) {
      workerTick("resolver", false);
      log("warn", "resolver: tick failed", { error: String(err?.message ?? err) });
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
}
