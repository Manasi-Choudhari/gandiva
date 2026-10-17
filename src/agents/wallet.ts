import { Mutex } from "async-mutex";
import { erc20Abi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { config, fromUnits, NETWORK, USDC_ADDRESS, USDC_EIP712 } from "../config.js";
import { decryptSecret, encryptSecret, secretsConfigured } from "../crypto/secrets.js";
import { db } from "../db.js";
import { SafePayer } from "../x402/safePayer.js";
import { chainClient, lookupAuthorization } from "../x402/chain.js";
import { capForWallet } from "../x402/spendCap.js";

/** Something the signed-in user can act on (status is the HTTP code to answer with). */
export class AgentWalletError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 502 | 503 = 400,
  ) {
    super(message);
  }
}

const lower = (a: string) => a.toLowerCase();

/** The user's own agent wallet address, created (with an encrypted key) on first use. */
export function ensureAgentWallet(user: string): string {
  const read = () => (db.prepare("SELECT agent_address FROM users WHERE address = ?").get(lower(user)) as { agent_address: string | null } | undefined)?.agent_address ?? null;
  const existing = read();
  if (existing) return existing;
  if (!secretsConfigured()) throw new AgentWalletError("this server has no SECRETS_KEY, so it cannot create agent wallets yet", 503);
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  db.prepare("INSERT OR IGNORE INTO users (address) VALUES (?)").run(lower(user));
  // Two tabs racing: only the first UPDATE wins, the other one reads the winner's address.
  db.prepare("UPDATE users SET agent_address = ?, agent_key_enc = ? WHERE address = ? AND agent_address IS NULL").run(address, encryptSecret(key), lower(user));
  return read()!;
}

const payers = new Map<string, SafePayer>();

/** The user's payer: signs with their agent wallet and answers to that wallet's own spend cap. */
export function getAgentPayer(user: string): SafePayer {
  const address = ensureAgentWallet(user);
  const cached = payers.get(lower(user));
  if (cached && cached.address === address) return cached;
  const row = db.prepare("SELECT agent_key_enc FROM users WHERE address = ?").get(lower(user)) as { agent_key_enc: string };
  let key: string;
  try {
    key = decryptSecret(row.agent_key_enc);
  } catch {
    throw new AgentWalletError("your agent wallet's key cannot be read (SECRETS_KEY changed?); the server operator must restore it", 503);
  }
  const payer = new SafePayer(key as `0x${string}`, capForWallet(address));
  payers.set(lower(user), payer);
  return payer;
}

/** USDC held by an address, in smallest units. */
export async function usdcBalance(address: string): Promise<bigint> {
  return (await chainClient().readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] })) as bigint;
}

export interface Withdrawal {
  id: number;
  ts: string;
  user_address: string;
  agent_address: string;
  to_address: string;
  amount: string;
  tx_hash: string | null;
  status: "settled" | "failed" | "unknown";
  reason: string | null;
}

export function listWithdrawals(agent?: string): Withdrawal[] {
  const rows = agent
    ? db.prepare("SELECT * FROM withdrawals WHERE lower(agent_address) = ? ORDER BY id DESC").all(lower(agent))
    : db.prepare("SELECT * FROM withdrawals ORDER BY id DESC LIMIT 500").all();
  return rows as Withdrawal[];
}

/**
 * Settles "unknown" withdrawals from the chain, like the ledger resolver does for payments: a used authorisation means the
 * USDC moved (-> settled, with its tx); an unused one past validBefore can never move (-> failed). Returns how many changed.
 */
export async function resolveUnknownWithdrawals(lookup: typeof lookupAuthorization = lookupAuthorization, now?: number): Promise<number> {
  const open = db.prepare("SELECT * FROM withdrawals WHERE status = 'unknown' AND auth_nonce IS NOT NULL ORDER BY id").all() as (Withdrawal & {
    auth_nonce: string;
    valid_before: number;
    signed_at: number;
  })[];
  let changed = 0;
  for (const w of open) {
    try {
      const out = await lookup({ from: w.agent_address, nonce: w.auth_nonce, validBefore: Number(w.valid_before), signedAt: Number(w.signed_at) }, now);
      const update = db.prepare("UPDATE withdrawals SET status = ?, tx_hash = ?, reason = ? WHERE id = ? AND status = 'unknown'");
      if (out.state === "used") changed += update.run("settled", out.txHash, "resolved from chain: the withdrawal was settled", w.id).changes;
      else if (out.state === "unused" && out.expired) changed += update.run("failed", null, "resolved from chain: the authorisation expired unused, nothing moved", w.id).changes;
    } catch (err: any) {
      console.warn(`[resolver] withdrawal #${w.id}: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 160)}`);
    }
  }
  return changed;
}

interface Settler {
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}
let facilitator: Settler | null = null;
const defaultSettler = (): Settler => (facilitator ??= new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: 60_000 }));

const locks = new Map<string, Mutex>();
const lockFor = (user: string) => locks.get(lower(user)) ?? (locks.set(lower(user), new Mutex()), locks.get(lower(user))!);

/**
 * Sends USDC from the user's agent wallet back to the user's own wallet. No gas is needed: the agent wallet signs an
 * ordinary x402 "exact" payment to the user and the facilitator submits it, exactly like a payment to a seller.
 * The destination is always the signed-in wallet.
 */
export async function withdraw(user: string, amount: bigint | "all", deps: { settler?: Settler; balance?: (a: string) => Promise<bigint> } = {}): Promise<Withdrawal> {
  return lockFor(user).runExclusive(async () => {
    const payer = getAgentPayer(user);
    const held = await (deps.balance ?? usdcBalance)(payer.address);
    const value = amount === "all" ? held : amount;
    if (value <= 0n) throw new AgentWalletError("your agent wallet has no USDC to withdraw");
    if (value > held) throw new AgentWalletError(`your agent wallet holds ${fromUnits(held)} USDC, less than the ${fromUnits(value)} you asked for`);

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: NETWORK,
      asset: USDC_ADDRESS,
      amount: value.toString(),
      payTo: lower(user),
      maxTimeoutSeconds: 120,
      extra: { ...USDC_EIP712, assetTransferMethod: "eip3009" },
    };
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: `${config.publicBaseUrl}/agent/withdraw`, description: "Withdraw from the agent wallet to its owner", mimeType: "application/json" },
      accepts: [requirements],
    };
    const base = { ts: new Date().toISOString(), user_address: lower(user), agent_address: payer.address, to_address: lower(user), amount: value.toString() };
    let auth: { nonce: string; validBefore: number } | null = null;
    const record = (status: Withdrawal["status"], tx: string | null, reason: string | null) => {
      const info = db
        .prepare("INSERT INTO withdrawals (ts,user_address,agent_address,to_address,amount,tx_hash,status,reason,auth_nonce,valid_before,signed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(base.ts, base.user_address, base.agent_address, base.to_address, base.amount, tx, status, reason, auth?.nonce ?? null, auth?.validBefore ?? null, Math.floor(Date.now() / 1000));
      return db.prepare("SELECT * FROM withdrawals WHERE id = ?").get(Number(info.lastInsertRowid)) as Withdrawal;
    };

    let payload: PaymentPayload;
    try {
      payload = await payer.signWithdrawal(required);
    } catch (err: any) {
      // Nothing was signed, so nothing can move.
      record("failed", null, `could not sign: ${String(err?.message ?? err).slice(0, 280)}`);
      throw new AgentWalletError(`could not sign the withdrawal (${String(err?.message ?? err).slice(0, 150)}). Nothing was moved.`, 502);
    }
    const a = (payload.payload as any)?.authorization;
    if (a?.nonce && a?.validBefore) auth = { nonce: String(a.nonce), validBefore: Number(a.validBefore) };

    let settled: SettleResponse;
    try {
      settled = await (deps.settler ?? defaultSettler()).settle(payload, requirements);
    } catch (err: any) {
      // The signed authorisation left our hands: it may still be settled. Say so instead of claiming nothing moved.
      record("unknown", null, String(err?.message ?? err).slice(0, 300));
      throw new AgentWalletError(`could not confirm the withdrawal (${String(err?.message ?? err).slice(0, 150)}); check your balance in a minute before trying again`, 502);
    }
    if (!settled.success) {
      record("failed", null, String(settled.errorReason ?? "settlement failed").slice(0, 300));
      throw new AgentWalletError(`the withdrawal was not settled: ${settled.errorReason ?? "unknown reason"}. Nothing was moved.`, 502);
    }
    return record("settled", settled.transaction, null);
  });
}
