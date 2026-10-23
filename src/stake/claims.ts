import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { workerTick } from "../workers.js";
import { getEvidence, holdEvidence, MAX_EVIDENCE_BODY } from "./evidence.js";
import { bondOnChain, chainView, claimOnChain, CLAIMS_PER_WINDOW, executeOnChain, proposeOnChain, relayerStatus, slashedOnChain, stakeEnabled, StakeError, stakeFees, verifierSet, vetoOnChain } from "./index.js";
import { checkClaim, checkRebuttal, claimIdOf, claimSignerOf, signClaim, signVeto, vetoSignerOf, type ClaimMessage } from "./verify.js";

/**
 * Stake claims for paid-and-rejected calls. A background worker walks each one through
 *   new -> open (checked, collecting verifier signatures) -> proposed (on chain, 30 min window) -> executed | vetoed
 * and closes the rest as expired, rejected, not_slashable or no_bond. Chain calls retry with backoff; nothing is ever sent twice,
 * because every step first reads the claim's state on chain.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL UNIQUE,
  evidence TEXT NOT NULL,
  seller TEXT NOT NULL,
  buyer TEXT NOT NULL,
  state TEXT NOT NULL,
  kind INTEGER,
  amount TEXT,
  message TEXT,
  sigs TEXT NOT NULL DEFAULT '{}',
  claim_id TEXT,
  execute_after INTEGER,
  rebuttal TEXT,
  veto_deadline INTEGER,
  veto_sigs TEXT NOT NULL DEFAULT '{}',
  paid TEXT,
  propose_tx TEXT,
  close_tx TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS claims_state ON claims (state, next_at);
`);

interface Row {
  id: number;
  ledger_id: number;
  evidence: Hex;
  seller: Hex;
  buyer: Hex;
  state: string;
  kind: number | null;
  amount: string | null;
  message: string | null;
  sigs: string;
  claim_id: Hex | null;
  execute_after: number | null;
  rebuttal: string | null;
  veto_deadline: number | null;
  veto_sigs: string;
  paid: string | null;
  propose_tx: string | null;
  close_tx: string | null;
  attempts: number;
  next_at: number;
  last_error: string | null;
  created_at: number;
  closed_at: number | null;
}

const ACTIVE = "('new', 'open', 'proposed')";
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** A claim with a valid rebuttal waits this long for the verifiers' veto, but never past the slash window (anyone may execute then). */
const VETO_WAIT_S = 3600;

const getRow = (id: number) => db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as Row | undefined;
const save = (id: number, fields: Partial<Row>) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE claims SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => (fields as any)[k]), id);
};
function close(row: Row, state: string, note: string | null, now: number, extra: Partial<Row> = {}) {
  save(row.id, { state, last_error: note, closed_at: now, attempts: 0, next_at: 0, ...extra });
  holdEvidence(row.evidence, false, now);
}

const toMessage = (json: string): ClaimMessage => {
  const m = JSON.parse(json);
  return { ...m, amount: BigInt(m.amount), deadline: BigInt(m.deadline) };
};
const fromMessage = (m: ClaimMessage) => JSON.stringify({ ...m, amount: m.amount.toString(), deadline: m.deadline.toString() });
const own = () => (config.stake.verifierKey ? privateKeyToAccount(config.stake.verifierKey).address : null);

/** Signatures from current verifiers only, sorted by signer as SellerStakeV2 requires. */
function usable(sigs: Record<string, Hex>, set: Hex[]): Hex[] {
  return Object.entries(sigs)
    .filter(([a]) => set.some((v) => v.toLowerCase() === a.toLowerCase()))
    .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
    .map(([, s]) => s);
}

/** Opens a claim for a paid-and-rejected ledger row (once per row). The worker does the rest. */
export function fileClaim(c: { ledgerId: number; evidence: Hex; seller: string; buyer: string }, now = Date.now()) {
  if (!stakeEnabled()) return;
  const r = db
    .prepare("INSERT INTO claims (ledger_id, evidence, seller, buyer, state, created_at) VALUES (?, ?, ?, ?, 'new', ?) ON CONFLICT(ledger_id) DO NOTHING")
    .run(c.ledgerId, c.evidence, c.seller, c.buyer, now);
  if (r.changes) holdEvidence(c.evidence, true);
}

/** Follows a claim the chain already has (a proposal or close whose answer we lost, or a keeper's execute) instead of sending it again. */
async function adopt(row: Row, id: Hex, on: { status: number; executeAfter: number }, now: number) {
  if (on.status === 1) return save(row.id, { state: "proposed", claim_id: id, execute_after: on.executeAfter * 1000, attempts: 0, next_at: 0 });
  const paid = on.status === 2 ? await slashedOnChain(id, on.executeAfter) : null;
  close(row, on.status === 2 ? "executed" : "vetoed", "state taken from the chain", now, { claim_id: id, paid: paid?.toString() ?? null });
}

const onChainFor = (seller: Hex) => db.prepare("SELECT amount FROM claims WHERE state = 'proposed' AND lower(seller) = ?").all(seller.toLowerCase()) as { amount: string | null }[];

/** Claims still holding one of the seller's slots: a vetoed one keeps its slot until its window ends. */
const slotsHeld = (seller: Hex, now: number) => (db.prepare("SELECT COUNT(*) AS n FROM claims WHERE lower(seller) = ? AND execute_after > ?").get(seller.toLowerCase(), now) as { n: number }).n;

/** True while the seller's bond still has something left after its claims already on chain, each with its fee. */
async function bondCovers(seller: Hex, open: { amount: string | null }[]) {
  const [staked, { slashFee }] = await Promise.all([bondOnChain(seller), stakeFees()]);
  return staked > open.reduce((a, c) => a + BigInt(c.amount ?? "0") + slashFee, 0n);
}

async function step(row: Row, now: number) {
  const nowS = Math.floor(now / 1000);
  if (row.state === "new") {
    const ev = getEvidence(row.evidence);
    if (!ev) return close(row, "rejected", "evidence missing", now);
    const v = await checkClaim(row.evidence, ev.bundle, chainView(), BigInt(nowS));
    if (!v.ok) {
      if (v.code === "retry") throw new Error(v.reason);
      return close(row, v.code, v.reason, now);
    }
    return save(row.id, { state: "open", kind: v.kind, amount: v.message.amount.toString(), message: fromMessage(v.message), attempts: 0, next_at: 0, last_error: null });
  }

  const m = toMessage(row.message!);
  const id = claimIdOf(m.seller, m.buyer, m.paymentNonce);
  const on = await claimOnChain(id);

  if (row.state === "open") {
    if (on.status !== 0) return adopt(row, id, on, now);
    // addRebuttal already checked it: a rebutted claim never goes on chain.
    if (row.rebuttal) return close(row, "vetoed", "the seller's rebuttal was accepted before the claim went on chain", now);
    if (BigInt(nowS) > m.deadline) return close(row, "expired", "not on chain before the claim deadline", now);
    const sigs = JSON.parse(row.sigs) as Record<string, Hex>;
    const me = own();
    if (me && !sigs[me]) {
      sigs[me] = await signClaim(config.stake.verifierKey as Hex, m, config.stake.contract as Hex);
      save(row.id, { sigs: JSON.stringify(sigs) });
    }
    const ready = usable(sigs, await verifierSet());
    if (ready.length < 2) return; // waiting for an outside verifier
    // The contract limits claims per seller per window, so waiting beats sending a call it will refuse.
    if (slotsHeld(m.seller, now) >= CLAIMS_PER_WINDOW) return save(row.id, { last_error: `waiting: this seller's ${CLAIMS_PER_WINDOW} claim slots are in use` });
    // A claim on nothing refunds nobody and no fee repays its gas.
    if (!(await bondCovers(m.seller, onChainFor(m.seller)))) return close(row, "no_bond", "the seller's bond is already spoken for", now);
    const p = await proposeOnChain(m, ready);
    return save(row.id, { state: "proposed", claim_id: p.id, execute_after: p.executeAfter * 1000, propose_tx: p.txHash, attempts: 0, next_at: 0, last_error: null });
  }

  // proposed
  if (on.status === 2 || on.status === 3) return adopt(row, id, on, now);
  if (row.rebuttal && row.veto_deadline) {
    const vsigs = JSON.parse(row.veto_sigs) as Record<string, Hex>;
    const me = own();
    if (me && !vsigs[me]) {
      const ev = getEvidence(row.evidence)!;
      if ((await checkRebuttal(ev.bundle, JSON.parse(row.rebuttal), chainView())).ok) {
        vsigs[me] = await signVeto(config.stake.verifierKey as Hex, { id, deadline: BigInt(row.veto_deadline) }, config.stake.contract as Hex);
        save(row.id, { veto_sigs: JSON.stringify(vsigs) });
      }
    }
    const ready = usable(vsigs, await verifierSet());
    if (ready.length >= 2 && nowS <= row.veto_deadline) {
      const v = await vetoOnChain(id, BigInt(row.veto_deadline), ready);
      return close(row, "vetoed", "the seller's rebuttal was accepted", now, { close_tx: v.txHash });
    }
    if (nowS <= row.veto_deadline) return; // give the verifiers time to judge the rebuttal
  }
  if (now < (row.execute_after ?? Infinity)) return;
  const x = await executeOnChain(id, row.seller);
  close(row, "executed", null, now, { paid: x.paid.toString(), close_tx: x.txHash });
}

/** One pass over the claims that are due. Exported for tests; the server runs it every 30 s. */
export async function runClaims(now = Date.now()) {
  const due = db.prepare(`SELECT * FROM claims WHERE state IN ${ACTIVE} AND next_at <= ? ORDER BY id`).all(now) as Row[];
  for (const row of due) {
    try {
      await step(row, now);
    } catch (err: any) {
      const attempts = row.attempts + 1;
      save(row.id, { attempts, next_at: now + Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS), last_error: String(err?.shortMessage ?? err?.message ?? err).split("\n")[0].slice(0, 300) });
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastHealth = 0;

/** Background worker, started like the payment resolver. Logs a warning when the relayer is low on ETH or a claim is stuck. */
export function startClaimWorker(intervalMs = 30_000) {
  if (timer || !stakeEnabled()) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runClaims();
      if (Date.now() - lastHealth > 10 * 60_000) {
        lastHealth = Date.now();
        const s = claimSummary();
        if (s.oldestOpenMinutes !== null && s.oldestOpenMinutes > 60) log("warn", "claims: stuck, check /registry/stake/claims", { open: s.open, oldestOpenMinutes: s.oldestOpenMinutes });
        const r = await relayerStatus();
        if (r.low) log("warn", "claims: relayer low on ETH, refill it or stakes and refunds will stop", { address: r.address, eth: r.eth });
      }
      workerTick("claims");
    } catch (err: any) {
      workerTick("claims", false);
      log("warn", "claims: tick failed", { error: String(err?.message ?? err) });
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
}

/** A verifier's signature on an open claim ("claim") or on a rebutted one ("veto"). Only current verifiers count. */
export async function addSignature(rowId: number, type: "claim" | "veto", signature: Hex): Promise<{ signer: Hex; count: number }> {
  const row = getRow(rowId);
  if (!row) throw new StakeError("no such claim", 404);
  const contract = config.stake.contract as Hex;
  let signer: Hex;
  try {
    if (type === "claim") {
      if (row.state !== "open") throw new StakeError(`claim is ${row.state}, not collecting claim signatures`, 409);
      signer = await claimSignerOf(toMessage(row.message!), signature, contract);
    } else {
      if (row.state !== "proposed" || !row.veto_deadline) throw new StakeError("claim has no rebuttal to veto on", 409);
      signer = await vetoSignerOf({ id: row.claim_id!, deadline: BigInt(row.veto_deadline) }, signature, contract);
    }
  } catch (err: any) {
    throw err instanceof StakeError ? err : new StakeError("malformed signature");
  }
  const set = await verifierSet();
  if (!set.some((v) => v.toLowerCase() === signer.toLowerCase())) throw new StakeError("signature is not from a current verifier", 403);
  const col = type === "claim" ? "sigs" : "veto_sigs";
  const sigs = { ...(JSON.parse(row[col]) as Record<string, Hex>), [signer]: signature };
  save(row.id, { [col]: JSON.stringify(sigs), next_at: 0 });
  return { signer, count: usable(sigs, set).length };
}

/**
 * The seller's answer to a kind 2 claim ("you got no valid response"): a receipt plus the body it covers. Checked here
 * before it is stored, so nobody can block the seller's real rebuttal with junk; verifiers then check it again themselves.
 */
export async function addRebuttal(rowId: number, r: { receipt: string; body: string }, now = Date.now()) {
  const row = getRow(rowId);
  if (!row) throw new StakeError("no such claim", 404);
  if (row.state !== "open" && row.state !== "proposed") throw new StakeError(`claim is ${row.state}; only an open or proposed claim can be rebutted`, 409);
  if (row.kind !== 2) throw new StakeError("this claim rests on the seller's own receipt and cannot be rebutted", 409);
  if (row.rebuttal) throw new StakeError("this claim already has a valid rebuttal", 409);
  if (row.execute_after && now >= row.execute_after) throw new StakeError("the slash window has closed; anyone may execute this claim now", 409);
  if (Buffer.byteLength(r.body) > MAX_EVIDENCE_BODY) throw new StakeError("body too large");
  const check = await checkRebuttal(getEvidence(row.evidence)!.bundle, r, chainView());
  if (!check.ok) throw new StakeError(check.reason);
  const vetoDeadline = Math.min(Math.floor(now / 1000) + VETO_WAIT_S, row.execute_after ? Math.floor(row.execute_after / 1000) : Infinity);
  save(row.id, { rebuttal: JSON.stringify(r), veto_deadline: vetoDeadline, next_at: 0 });
  return { vetoDeadline };
}

/** What verifiers and the UI read: the message to sign, signature counts and where each claim stands. */
export function listClaims(q: { state?: string; seller?: string; limit?: number } = {}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.state === "active") where.push(`state IN ${ACTIVE}`);
  else if (q.state) (where.push("state = ?"), args.push(q.state));
  if (q.seller) (where.push("lower(seller) = ?"), args.push(q.seller.toLowerCase()));
  const rows = db.prepare(`SELECT * FROM claims ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, q.limit ?? 200) as Row[];
  return rows.map((r) => ({
    id: r.id,
    ledgerId: r.ledger_id,
    evidence: r.evidence,
    seller: r.seller,
    buyer: r.buyer,
    state: r.state,
    kind: r.kind,
    amount: r.amount,
    message: r.message ? JSON.parse(r.message) : null,
    claimId: r.claim_id,
    executeAfter: r.execute_after,
    signatures: Object.keys(JSON.parse(r.sigs)),
    rebuttal: r.rebuttal ? JSON.parse(r.rebuttal) : null,
    vetoDeadline: r.veto_deadline,
    vetoSignatures: Object.keys(JSON.parse(r.veto_sigs)),
    paid: r.paid,
    proposeTx: r.propose_tx,
    closeTx: r.close_tx,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    closedAt: r.closed_at,
  }));
}

export function claimSummary(now = Date.now()) {
  const r = db.prepare(`SELECT COUNT(*) AS open, MIN(created_at) AS oldest FROM claims WHERE state IN ${ACTIVE}`).get() as { open: number; oldest: number | null };
  return { open: r.open, oldestOpenMinutes: r.oldest === null ? null : Math.floor((now - r.oldest) / 60_000) };
}

/** Refunds actually paid out of a seller's bond (executed claims, amounts from the Slashed event). */
export function slashedTotal(seller: string): { count: number; amount: bigint } {
  const rows = db.prepare("SELECT paid FROM claims WHERE state = 'executed' AND lower(seller) = ?").all(seller.toLowerCase()) as { paid: string | null }[];
  return { count: rows.length, amount: rows.reduce((a, r) => a + BigInt(r.paid ?? "0"), 0n) };
}
