import { z } from "zod";
import { db } from "../db.js";
import { config, MAX_PRICE_UNITS, NETWORK, USDC_ADDRESS } from "../config.js";

export const CATEGORIES = ["data", "inference", "scraping"] as const;
export type Category = (typeof CATEGORIES)[number];

export const LEDGER_STATUSES = ["paid", "paid_output_rejected", "refused", "failed_not_charged", "unconfirmed"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x EVM address");

export const serviceInput = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,64}$/).optional(),
  name: z.string().min(1).max(80),
  category: z.enum(CATEGORIES),
  endpoint: z.string().url(),
  method: z.enum(["GET", "POST"]).default("GET"),
  price: z
    .string()
    .regex(/^\d+$/, "price is in USDC smallest units (6 decimals), e.g. 1000 = 0.001 USDC")
    .refine((p) => BigInt(p) > 0n && BigInt(p) <= MAX_PRICE_UNITS, "price must be > 0 and <= 100000 (0.10 USDC)"),
  network: z.string().default(NETWORK),
  asset: address.default(USDC_ADDRESS),
  payTo: address,
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  description: z.string().max(500).default(""),
  owner: z.string().max(80).default("external"),
});
export type ServiceInput = z.infer<typeof serviceInput>;

/** Result of asking the listed endpoint for its 402: "verified" = terms match the listing, "mismatch" = they do not, "unchecked" = could not tell. */
export const VERIFICATIONS = ["verified", "mismatch", "unchecked"] as const;
export type Verification = (typeof VERIFICATIONS)[number];

export interface Service {
  id: string;
  name: string;
  category: Category;
  endpoint: string;
  method: "GET" | "POST";
  price: string;
  network: string;
  asset: string;
  payTo: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  description: string;
  owner: string;
  verification: Verification;
  verificationNote: string;
  verifiedAt: string | null;
}

export interface Reputation {
  attempts: number;
  successes: number;
  successRate: number;
  medianLatencyMs: number | null;
  /** Time-weighted score in (0, 1]; see computeReputation. */
  score: number;
  /** Too few calls to judge yet. */
  isNew: boolean;
}

export type ServiceWithReputation = Service & { reputation: Reputation };

const rowToService = (r: any): Service => ({
  id: r.id,
  name: r.name,
  category: r.category,
  endpoint: r.endpoint,
  method: r.method,
  price: r.price,
  network: r.network,
  asset: r.asset,
  payTo: r.pay_to,
  inputSchema: JSON.parse(r.input_schema),
  outputSchema: JSON.parse(r.output_schema),
  description: r.description,
  owner: r.owner,
  verification: r.verification,
  verificationNote: r.verification_note,
  verifiedAt: r.verified_at,
});

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);

export function upsertService(input: ServiceInput): Service {
  const s = serviceInput.parse(input);
  const id = s.id ?? slug(s.name);
  db.prepare(
    `INSERT INTO services (id,name,category,endpoint,method,price,network,asset,pay_to,input_schema,output_schema,description,owner)
     VALUES (@id,@name,@category,@endpoint,@method,@price,@network,@asset,@payTo,@inputSchema,@outputSchema,@description,@owner)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, endpoint=excluded.endpoint,
       method=excluded.method, price=excluded.price, network=excluded.network, asset=excluded.asset, pay_to=excluded.pay_to,
       input_schema=excluded.input_schema, output_schema=excluded.output_schema, description=excluded.description, owner=excluded.owner,
       verification='unchecked', verification_note='', verified_at=NULL`,
  ).run({ ...s, id, inputSchema: JSON.stringify(s.inputSchema), outputSchema: JSON.stringify(s.outputSchema) });
  return getService(id)!;
}

/** Records what the last probe of the listing's 402 found. An edited listing goes back to "unchecked" until it is probed again. */
export function setVerification(id: string, v: { verification: Verification; note: string }) {
  db.prepare("UPDATE services SET verification = ?, verification_note = ?, verified_at = ? WHERE id = ?").run(v.verification, v.note.slice(0, 300), new Date().toISOString(), id);
}

export const SEED_OWNER = "gandiva";
export const MAX_EXTERNAL_SERVICES = 200;

export class RegistryError extends Error {
  constructor(message: string, readonly status: 403 | 409 = 409) {
    super(message);
  }
}

/**
 * Public registration (judges list their own reference sellers). Anyone may add a listing, but only its original
 * payTo may update it, and the seeded marketplace sellers can never be overwritten from outside.
 */
export function registerExternal(input: unknown): Service {
  const s = serviceInput.parse({ ...(input as object), owner: "external" });
  const id = s.id ?? slug(s.name);
  const existing = getService(id);
  if (existing) {
    if (existing.owner === SEED_OWNER) throw new RegistryError(`"${id}" is a built-in marketplace service and cannot be overwritten; choose another id`, 403);
    // A payTo address is public, so it proves nothing; wallet-owned listings are changed only by a signed-in owner.
    if (isWalletOwner(existing.owner)) throw new RegistryError(`"${id}" belongs to a signed-in wallet; it can only be changed from the Sell tab by that wallet`, 403);
    if (existing.payTo.toLowerCase() !== s.payTo.toLowerCase()) throw new RegistryError(`"${id}" is already listed by a different payTo; choose another id`);
  } else {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM services WHERE owner != ?").get(SEED_OWNER) as { n: number };
    if (n >= MAX_EXTERNAL_SERVICES) throw new RegistryError(`registry is full (${MAX_EXTERNAL_SERVICES} external listings)`, 403);
  }
  return upsertService({ ...s, id });
}

export const MAX_LISTINGS_PER_WALLET = 20;
export const walletOwner = (address: string) => `wallet:${address.toLowerCase()}`;
const isWalletOwner = (owner: string) => owner.startsWith("wallet:");

/**
 * Listing made by a signed-in wallet (Sell tab). Earnings go to that wallet (payTo is forced; only server code may pass
 * `payTo`, e.g. an agent chain paid into the owner's agent wallet), and only that wallet can change or remove the listing
 * again. Posting an id that already belongs to this wallet updates it.
 */
export function registerForWallet(input: unknown, wallet: string, opts: { payTo?: string } = {}): Service {
  const owner = walletOwner(wallet);
  const s = serviceInput.parse({ ...(input as object), payTo: opts.payTo ?? wallet, owner });
  const id = s.id ?? slug(s.name);
  if (!/^[a-z0-9-]{2,64}$/.test(id)) throw new RegistryError("name must contain letters or numbers (the listing id is made from it)", 409);
  const existing = getService(id);
  if (existing) {
    if (existing.owner === SEED_OWNER) throw new RegistryError(`"${id}" is a built-in marketplace service and cannot be overwritten; choose another name`, 403);
    if (existing.owner !== owner) throw new RegistryError(`"${id}" is already listed by someone else; choose another name`, 409);
  } else {
    const mine = listByOwner(wallet).length;
    if (mine >= MAX_LISTINGS_PER_WALLET) throw new RegistryError(`you already have ${MAX_LISTINGS_PER_WALLET} listings; delete one first`, 403);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM services WHERE owner != ?").get(SEED_OWNER) as { n: number };
    if (n >= MAX_EXTERNAL_SERVICES) throw new RegistryError(`registry is full (${MAX_EXTERNAL_SERVICES} external listings)`, 403);
  }
  return upsertService({ ...s, id });
}

export function listByOwner(wallet: string): Service[] {
  return db.prepare("SELECT * FROM services WHERE owner = ? ORDER BY created_at DESC, id").all(walletOwner(wallet)).map(rowToService);
}

/** Removes a listing only if this wallet owns it. */
export function deleteOwnedService(id: string, wallet: string): "deleted" | "not_found" | "not_yours" {
  const existing = getService(id);
  if (!existing) return "not_found";
  if (existing.owner !== walletOwner(wallet)) return "not_yours";
  return deleteService(id) ? "deleted" : "not_found";
}

export function deleteService(id: string) {
  db.prepare("DELETE FROM hosted_sellers WHERE service_id = ?").run(id);
  db.prepare("DELETE FROM chain_sellers WHERE service_id = ?").run(id);
  return db.prepare("DELETE FROM services WHERE id = ?").run(id).changes > 0;
}

export function listServices(): Service[] {
  return db.prepare("SELECT * FROM services").all().map(rowToService);
}

export function getService(id: string): Service | undefined {
  const r = db.prepare("SELECT * FROM services WHERE id = ?").get(id);
  return r ? rowToService(r) : undefined;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * Turns ledger rows into a reputation. The score is time-weighted: a call's weight halves every half-life, so a seller
 * that misbehaved long ago slowly earns its way back, while a fresh failure counts fully. attempts/successes/successRate
 * stay plain counts for display.
 */
export function computeReputation(
  rows: { status: LedgerStatus; latency_ms: number; ts: string }[],
  now = Date.now(),
  halfLifeMs = config.reputation.halfLifeMs,
  newAttempts = config.reputation.newAttempts,
): Reputation {
  const successes = rows.filter((r) => r.status === "paid");
  const attempts = rows.length;
  let weightedAttempts = 0;
  let weightedSuccesses = 0;
  for (const r of rows) {
    const age = Math.max(0, now - Date.parse(r.ts));
    const w = halfLifeMs > 0 ? 0.5 ** (age / halfLifeMs) : 1;
    weightedAttempts += w;
    if (r.status === "paid") weightedSuccesses += w;
  }
  return {
    attempts,
    successes: successes.length,
    successRate: attempts ? successes.length / attempts : 0,
    medianLatencyMs: median(successes.map((r) => r.latency_ms)),
    // Optimistic prior: an untried seller scores 1.0 so it gets explored; one fresh bad call halves it
    score: (weightedSuccesses + 1) / (weightedAttempts + 1),
    isNew: attempts < newAttempts,
  };
}

/** Reputation comes from the buyer-side ledger: every attempted call counts, only clean "paid" counts as success. */
export function reputationFor(serviceId: string): Reputation {
  const rows = db
    .prepare("SELECT status, latency_ms, ts FROM ledger WHERE service_id = ? AND status != 'unconfirmed' AND (reason IS NULL OR (reason NOT LIKE 'budget:%' AND reason NOT LIKE 'spend cap:%' AND reason NOT LIKE 'payment rejected:%'))")
    .all(serviceId) as { status: LedgerStatus; latency_ms: number; ts: string }[];
  return computeReputation(rows);
}

/** The last calls the buyer made to a listing, oldest first, for sparklines. */
export function recentCalls(serviceId: string, limit = 20) {
  const rows = db.prepare("SELECT ts, status, latency_ms FROM ledger WHERE service_id = ? AND status != 'unconfirmed' ORDER BY id DESC LIMIT ?").all(serviceId, limit) as { ts: string; status: LedgerStatus; latency_ms: number }[];
  return rows.reverse().map((r) => ({ ts: r.ts, status: r.status, latencyMs: r.latency_ms }));
}

export function searchServices(q: { category?: string; maxPrice?: string; sort?: string } = {}): ServiceWithReputation[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.category) {
    where.push("category = ?");
    params.push(q.category);
  }
  const rows = db.prepare(`SELECT * FROM services ${where.length ? "WHERE " + where.join(" AND ") : ""}`).all(...params);
  let list = rows.map(rowToService).map((s) => ({ ...s, reputation: reputationFor(s.id) }));
  if (q.maxPrice) {
    const max = BigInt(q.maxPrice);
    list = list.filter((s) => BigInt(s.price) <= max);
  }
  const sort = q.sort ?? "rank";
  list.sort((a, b) => {
    if (sort === "price") return Number(BigInt(a.price) - BigInt(b.price));
    if (sort === "latency") return (a.reputation.medianLatencyMs ?? 1e9) - (b.reputation.medianLatencyMs ?? 1e9);
    return rankCompare(a, b);
  });
  return list;
}

let credibilityScore: (serviceId: string) => number | undefined = () => undefined;
/** Lets the credibility module feed ranking without an import cycle. */
export function setCredibilityLookup(fn: (serviceId: string) => number | undefined) {
  credibilityScore = fn;
}

/**
 * Buyer's choice order: listings whose 402 contradicts them last, then reputation score, then price, then credibility
 * (proofs, stake, history), then latency.
 */
export function rankCompare(a: ServiceWithReputation, b: ServiceWithReputation) {
  const dm = Number(a.verification === "mismatch") - Number(b.verification === "mismatch");
  if (dm) return dm;
  const ds = b.reputation.score - a.reputation.score;
  if (Math.abs(ds) > 0.05) return ds;
  const dp = BigInt(a.price) - BigInt(b.price);
  if (dp !== 0n) return dp < 0n ? -1 : 1;
  const dc = (credibilityScore(b.id) ?? 0) - (credibilityScore(a.id) ?? 0);
  if (dc) return dc;
  return (a.reputation.medianLatencyMs ?? 1e9) - (b.reputation.medianLatencyMs ?? 1e9);
}

export type RankRule = "verification" | "reputation" | "price" | "credibility" | "latency" | "tie";

/** Which rule of rankCompare put `a` ahead of `b`, in words. Must follow rankCompare step by step. */
export function explainRank(a: ServiceWithReputation, b: ServiceWithReputation): { rule: RankRule; detail: string } {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if ((a.verification === "mismatch") !== (b.verification === "mismatch")) {
    return { rule: "verification", detail: `${b.name}'s live 402 contradicts its listing, so it goes last whatever its other numbers` };
  }
  const ds = a.reputation.score - b.reputation.score;
  if (Math.abs(ds) > 0.05) return { rule: "reputation", detail: `reputation ${pct(a.reputation.score)} vs ${pct(b.reputation.score)} (more than 5 points apart)` };
  const dp = BigInt(a.price) - BigInt(b.price);
  const close = `reputation within 5 points (${pct(a.reputation.score)} vs ${pct(b.reputation.score)})`;
  if (dp !== 0n) return { rule: "price", detail: `${close}, so the cheaper one wins: ${fromUnitsShort(a.price)} vs ${fromUnitsShort(b.price)} USDC` };
  const ca = credibilityScore(a.id) ?? 0;
  const cb = credibilityScore(b.id) ?? 0;
  if (ca !== cb) return { rule: "credibility", detail: `${close} and the same price, so higher credibility wins: ${ca} vs ${cb}/100` };
  const la = a.reputation.medianLatencyMs;
  const lb = b.reputation.medianLatencyMs;
  if ((la ?? 1e9) !== (lb ?? 1e9)) return { rule: "latency", detail: `same reputation band, price and credibility, so the faster one wins: ${la ?? "untested"} vs ${lb ?? "untested"} ms` };
  return { rule: "tie", detail: "identical on every parameter; listing order decides" };
}

const fromUnitsShort = (u: string) => (Number(u) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

export interface LedgerEntry {
  runId?: string | null;
  buyer: string;
  seller: string;
  serviceId?: string | null;
  serviceName: string;
  endpoint: string;
  listed: string;
  asked?: string | null;
  paid: string;
  txHash?: string | null;
  status: LedgerStatus;
  reason?: string | null;
  latencyMs: number;
  /** EIP-3009 authorisation that was signed; kept so an unconfirmed payment can be settled against the chain later. */
  auth?: { from: string; nonce: string; validBefore: number; signedAt: number } | null;
}

export function addLedger(e: LedgerEntry) {
  const ts = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO ledger (ts,run_id,buyer,seller,service_id,service_name,endpoint,listed,asked,paid,tx_hash,status,reason,latency_ms,auth_from,auth_nonce,valid_before,signed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      ts, e.runId ?? null, e.buyer, e.seller, e.serviceId ?? null, e.serviceName, e.endpoint, e.listed, e.asked ?? null, e.paid, e.txHash ?? null, e.status, e.reason ?? null, Math.round(e.latencyMs),
      e.auth?.from ?? null, e.auth?.nonce ?? null, e.auth?.validBefore ?? null, e.auth?.signedAt ?? null,
    );
  return { id: Number(info.lastInsertRowid), ts, ...e };
}

/**
 * Settle a row once the chain has answered. Normally that is an "unconfirmed" row; a "failed_not_charged" row can also be
 * corrected (`from`) if the seller turns out to have settled the authorisation late.
 */
export function resolveLedger(
  id: number,
  r: { status: LedgerStatus; paid: string; txHash?: string | null; reason: string },
  from: LedgerStatus[] = ["unconfirmed"],
) {
  const marks = from.map(() => "?").join(",");
  return db.prepare(`UPDATE ledger SET status = ?, paid = ?, tx_hash = ?, reason = ? WHERE id = ? AND status IN (${marks})`).run(r.status, r.paid, r.txHash ?? null, r.reason, id, ...from).changes > 0;
}

export function listUnconfirmed() {
  return db.prepare("SELECT * FROM ledger WHERE status = 'unconfirmed' ORDER BY id").all() as any[];
}

/** Rows we recorded as "not charged" after signing, whose authorisation could still be settled by the seller (until validBefore). */
export function listAuditable(nowSeconds: number, graceSeconds = 90) {
  return db
    .prepare("SELECT * FROM ledger WHERE status = 'failed_not_charged' AND auth_nonce IS NOT NULL AND valid_before >= ? ORDER BY id")
    .all(nowSeconds - graceSeconds) as any[];
}

/** Money spent or possibly spent since `sinceIso` (all buyers, or just one wallet): charged rows plus unconfirmed ones at the amount they asked. */
export function spentSince(sinceIso: string, buyer?: string): bigint {
  const rows = db
    .prepare("SELECT status, paid, asked FROM ledger WHERE ts >= ? AND status IN ('paid','paid_output_rejected','unconfirmed')" + (buyer ? " AND lower(buyer) = ?" : ""))
    .all(...(buyer ? [sinceIso, buyer.toLowerCase()] : [sinceIso])) as { status: LedgerStatus; paid: string; asked: string | null }[];
  return rows.reduce((sum, r) => sum + BigInt(r.status === "unconfirmed" ? (r.asked ?? "0") : r.paid), 0n);
}

export function listLedger(q: { runId?: string; buyer?: string; limit?: number } = {}) {
  const rows = q.runId
    ? db.prepare("SELECT * FROM ledger WHERE run_id = ? ORDER BY id DESC").all(q.runId)
    : q.buyer
      ? db.prepare("SELECT * FROM ledger WHERE lower(buyer) = ? ORDER BY id DESC LIMIT ?").all(q.buyer.toLowerCase(), q.limit ?? 500)
      : db.prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT ?").all(q.limit ?? 500);
  return rows as any[];
}

export function addSale(s: { seller: string; payer?: string; amount: string; txHash?: string; status: string; reason?: string; latencyMs: number }) {
  db.prepare("INSERT INTO sales (ts,seller,payer,amount,tx_hash,status,reason,latency_ms) VALUES (?,?,?,?,?,?,?,?)").run(
    new Date().toISOString(),
    s.seller,
    s.payer ?? null,
    s.amount,
    s.txHash ?? null,
    s.status,
    s.reason ?? null,
    Math.round(s.latencyMs),
  );
}

export function listSales(limit = 500) {
  return db.prepare("SELECT * FROM sales ORDER BY id DESC LIMIT ?").all(limit) as any[];
}
