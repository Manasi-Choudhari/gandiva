import { createPublicClient, erc20Abi, http, verifyMessage, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config, fromUnits, USDC_ADDRESS } from "../config.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { slashedTotal } from "../stake/claims.js";
import { stakeOf, type StakePosition } from "../stake/index.js";
import { getService, listServices, reputationFor, SEED_OWNER, setCredibilityLookup, type Service, type ServiceWithReputation } from "./store.js";

/**
 * Seller credibility without KYC: everything here is something a seller proves with code, keys or money, never with
 * identity documents. Each check earns points; the total (0-100) is shown on the marketplace and breaks ties in ranking.
 */
export type CheckStatus = "pass" | "partial" | "fail" | "unknown";
export interface CredibilityCheck {
  id: "protocol" | "ownership" | "track_record" | "stake" | "wallet_history" | "transport" | "tenure";
  label: string;
  status: CheckStatus;
  points: number;
  max: number;
  detail: string;
}
export interface Credibility {
  score: number;
  level: "high" | "medium" | "low" | "unproven";
  checks: CredibilityCheck[];
  computedAt: string;
}

db.exec(`
CREATE TABLE IF NOT EXISTS payto_proofs (
  service_id TEXT PRIMARY KEY,
  pay_to TEXT NOT NULL,
  signature TEXT NOT NULL,
  ts TEXT NOT NULL
);
`);

/** What a seller signs with its payTo wallet to prove it controls where the money goes. */
export const proofMessage = (s: Pick<Service, "id" | "payTo">) => `Gandiva marketplace: I control payTo ${s.payTo.toLowerCase()} for listing "${s.id}".`;

export class ProofError extends Error {}

export async function submitPayToProof(serviceId: string, signature: string) {
  const s = getService(serviceId);
  if (!s) throw new ProofError("service not found");
  const ok = await verifyMessage({ address: s.payTo as Hex, message: proofMessage(s), signature: signature as Hex }).catch(() => false);
  if (!ok) throw new ProofError(`signature is not from ${s.payTo} over the expected message`);
  db.prepare("INSERT INTO payto_proofs (service_id,pay_to,signature,ts) VALUES (?,?,?,?) ON CONFLICT(service_id) DO UPDATE SET pay_to=excluded.pay_to, signature=excluded.signature, ts=excluded.ts").run(
    s.id, s.payTo.toLowerCase(), signature, new Date().toISOString(),
  );
  cache.delete(s.id);
  return { ok: true };
}

/** A proof only counts while the listing still pays the address that signed it. */
function hasProof(s: Service): boolean {
  const row = db.prepare("SELECT pay_to FROM payto_proofs WHERE service_id = ?").get(s.id) as { pay_to: string } | undefined;
  return row?.pay_to === s.payTo.toLowerCase();
}

/**
 * Did the payTo's owner write this listing? Only then may its output schema bind that payTo's stake: anyone can list
 * someone else's payTo with a stricter schema (or a proxy endpoint) and turn honest answers into slashable claims.
 */
export const payToProven = (s: Service) => s.owner.startsWith("wallet:") || hasProof(s);

/** The built-in sellers' keys are in .env, so the marketplace signs their proofs itself at boot. */
export async function proveBuiltIns() {
  const keys = Object.entries(process.env).filter(([k, v]) => /^(SELLER_KEY_|TRAVEL_BRIEF_KEY$)/.test(k) && /^0x[0-9a-fA-F]{64}$/.test(v ?? ""));
  const byAddress = new Map(keys.map(([, v]) => [privateKeyToAccount(v as Hex).address.toLowerCase(), privateKeyToAccount(v as Hex)]));
  for (const s of listServices().filter((x) => x.owner === SEED_OWNER)) {
    const account = byAddress.get(s.payTo.toLowerCase());
    if (account && !hasProof(s)) await submitPayToProof(s.id, await account.signMessage({ message: proofMessage(s) }));
  }
}

const pub = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
const walletCache = new Map<string, { at: number; nonce: number; usdc: bigint; contract: boolean } | null>();
async function walletHistory(address: string) {
  const key = address.toLowerCase();
  const hit = walletCache.get(key);
  if (hit !== undefined && hit !== null && Date.now() - hit.at < 10 * 60_000) return hit;
  if (process.env.VITEST) return null;
  try {
    const [nonce, usdc, code] = await Promise.all([
      pub.getTransactionCount({ address: address as Hex }),
      pub.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address as Hex] }),
      pub.getCode({ address: address as Hex }),
    ]);
    const v = { at: Date.now(), nonce, usdc, contract: Boolean(code && code !== "0x") };
    walletCache.set(key, v);
    return v;
  } catch {
    return hit ?? null;
  }
}

/**
 * Full credit from 0.05 USDC bonded. A bond nobody can slash (no receipt signer) is worth at most half; one being unstaked
 * is worth nothing, since it is about to leave. Each executed slash costs 5 points.
 */
export function stakeCheck(stake: Pick<StakePosition, "staked" | "unlockAt" | "slashable">, slashed: { count: number; amount: bigint }): CredibilityCheck {
  const staked = BigInt(stake.staked);
  const cap = stake.unlockAt ? 0 : stake.slashable ? 20 : 10;
  const points = Math.max(0, Math.min(cap, Math.round(Number(staked) / 2_500)) - slashed.count * 5);
  const detail =
    staked === 0n
      ? "nothing staked"
      : `${fromUnits(staked)} USDC bonded in SellerStakeV2` +
        (stake.unlockAt ? ", unstaking (counts 0 until it is staked again)" : stake.slashable ? ", slashable by 2 of 3 verifiers; full credit from 0.05" : ", but no receipt signer so it cannot be slashed (at most 10 of 20)");
  return {
    id: "stake",
    label: "Stake (skin in the game)",
    status: points >= 20 ? "pass" : points > 0 ? "partial" : "fail",
    points,
    max: 20,
    detail: detail + (slashed.count ? `; slashed ${slashed.count}x for junk (${fromUnits(slashed.amount)} USDC refunded to buyers)` : ""),
  };
}

const listedAt = (id: string) => (db.prepare("SELECT created_at FROM services WHERE id = ?").get(id) as { created_at: string } | undefined)?.created_at;

/** Scores one listing. Pure apart from the chain reads (stake, wallet), which degrade to "unknown" when unreachable. */
export async function computeCredibility(s: ServiceWithReputation, now = Date.now()): Promise<Credibility> {
  const checks: CredibilityCheck[] = [];
  const rep = s.reputation;

  checks.push(
    s.verification === "verified"
      ? { id: "protocol", label: "x402 conformance", status: "pass", points: 20, max: 20, detail: "a live probe of the endpoint returned a 402 matching the listed price, token, network and payTo" }
      : s.verification === "mismatch"
        ? { id: "protocol", label: "x402 conformance", status: "fail", points: 0, max: 20, detail: `the endpoint's 402 contradicts the listing (${s.verificationNote})` }
        : { id: "protocol", label: "x402 conformance", status: "unknown", points: 8, max: 20, detail: s.verificationNote || "not probed yet" },
  );

  const stake = await stakeOf(s.payTo);
  const staked = BigInt(stake.staked);
  const walletOwned = s.owner === `wallet:${s.payTo.toLowerCase()}`;
  const proof = hasProof(s);
  checks.push(
    proof || walletOwned || staked > 0n
      ? {
          id: "ownership",
          label: "Controls its payout wallet",
          status: "pass",
          points: 15,
          max: 15,
          detail: proof ? "signed a message with the payTo key" : walletOwned ? "listed by the payTo wallet after a signed sign-in" : "staked from the payTo wallet (needs its signature)",
        }
      : { id: "ownership", label: "Controls its payout wallet", status: "fail", points: 0, max: 15, detail: "no signature from the payTo wallet yet; anyone can type an address" },
  );

  const volume = Math.min(1, rep.attempts / 10);
  const trackPoints = Math.round(25 * rep.successRate * volume);
  checks.push({
    id: "track_record",
    label: "Track record",
    status: rep.attempts === 0 ? "unknown" : trackPoints >= 20 ? "pass" : trackPoints > 0 ? "partial" : "fail",
    points: trackPoints,
    max: 25,
    detail: rep.attempts ? `${rep.successes}/${rep.attempts} calls delivered valid output (${Math.round(rep.successRate * 100)}%); full credit from 10 calls` : "no paid calls yet",
  });

  checks.push(stakeCheck(stake, slashedTotal(s.payTo)));

  const w = await walletHistory(s.payTo);
  checks.push(
    !w
      ? { id: "wallet_history", label: "On-chain wallet history", status: "unknown", points: 0, max: 10, detail: "could not read the chain" }
      : w.nonce > 0 || w.usdc > 0n
        ? { id: "wallet_history", label: "On-chain wallet history", status: "pass", points: 10, max: 10, detail: `payTo has ${w.nonce} sent tx and holds ${fromUnits(w.usdc)} USDC${w.contract ? " (smart contract wallet)" : ""}` }
        : { id: "wallet_history", label: "On-chain wallet history", status: "fail", points: 0, max: 10, detail: "payTo has never been used on Base Sepolia" },
  );

  const https = s.endpoint.startsWith("https://") || (s.owner === SEED_OWNER && config.publicBaseUrl.startsWith("https://"));
  checks.push(
    https
      ? { id: "transport", label: "HTTPS endpoint", status: "pass", points: 5, max: 5, detail: "served over TLS" }
      : { id: "transport", label: "HTTPS endpoint", status: "fail", points: 0, max: 5, detail: "plain http" },
  );

  const created = listedAt(s.id);
  const ageH = created ? (now - Date.parse(created.replace(" ", "T") + "Z")) / 3_600_000 : 0;
  checks.push({
    id: "tenure",
    label: "Listing age",
    status: ageH >= 1 ? "pass" : "partial",
    points: ageH >= 1 ? 5 : Math.round(5 * Math.max(0, ageH)),
    max: 5,
    detail: created ? `listed ${ageH >= 1 ? `${ageH.toFixed(1)} h` : `${Math.round(ageH * 60)} min`} ago` : "unknown",
  });

  const score = checks.reduce((a, c) => a + c.points, 0);
  return { score, level: score >= 75 ? "high" : score >= 50 ? "medium" : score >= 25 ? "low" : "unproven", checks, computedAt: new Date(now).toISOString() };
}

const cache = new Map<string, Credibility>();

/** Last computed credibility (sync, for ranking); undefined until the first refresh has run. */
export const credibilityCached = (serviceId: string) => cache.get(serviceId);
setCredibilityLookup((id) => cache.get(id)?.score);

export async function credibilityFor(serviceId: string, fresh = false): Promise<Credibility | undefined> {
  if (!fresh && cache.has(serviceId)) return cache.get(serviceId);
  const s = getService(serviceId);
  if (!s) return undefined;
  const c = await computeCredibility({ ...s, reputation: reputationFor(s.id) });
  cache.set(s.id, c);
  return c;
}

export async function refreshCredibility() {
  for (const s of listServices()) await credibilityFor(s.id, true).catch(() => undefined);
  for (const id of cache.keys()) if (!getService(id)) cache.delete(id);
}

export function startCredibilityRefresh(everyMs = 60_000) {
  const run = () => refreshCredibility().catch((err) => log("error", "credibility: refresh failed", { error: String(err?.message ?? err) }));
  void proveBuiltIns()
    .catch((err) => log("error", "credibility: built-in proofs failed", { error: String(err?.message ?? err) }))
    .then(run);
  setInterval(run, everyMs).unref();
}
