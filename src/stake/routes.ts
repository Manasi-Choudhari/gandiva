import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { toUnits } from "../config.js";
import { clientIp } from "../http/clientIp.js";
import { listServices } from "../registry/store.js";
import { addRebuttal, addSignature, claimSummary, listClaims, slashedTotal } from "./claims.js";
import { getEvidence } from "./evidence.js";
import {
  listStakeEvents,
  prepareReceiptSigner,
  prepareStake,
  prepareUnstake,
  relayReceiptSigner,
  relayStake,
  relayUnstake,
  stakeEnabled,
  StakeError,
  stakeInfo,
  stakeOf,
  withdrawFor,
} from "./index.js";

export const stakeRoutes = new Hono();

const isAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const fail = (c: Context, err: any) =>
  err instanceof StakeError ? c.json({ error: err.message }, err.status) : c.json({ error: String(err?.shortMessage ?? err?.message ?? err).split("\n")[0] }, 400);

// Every relayed call costs the relayer gas, so POSTs are rate-limited per client IP and per address, in memory.
const hits = new Map<string, number[]>();
function overLimit(key: string, max: number, now = Date.now()) {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= max) return true;
  // shortcut: the map is simply cleared past 10 000 keys and is per process; move it to the database if the API ever scales out.
  if (hits.size > 10_000) hits.clear();
  hits.set(key, [...recent, now]);
  return false;
}
const LIMITS = { relay: { ip: 60, address: 10 }, signature: { ip: 600, address: 0 }, rebuttal: { ip: 20, address: 0 } } as const;
function limited(c: Context, scope: keyof typeof LIMITS, address?: string) {
  const l = LIMITS[scope];
  if (overLimit(`${scope}:ip:${clientIp(c)}`, l.ip)) return true;
  return address !== undefined && overLimit(`${scope}:a:${address.toLowerCase()}`, l.address);
}
const tooMany = (c: Context) => c.json({ error: "too many requests, try again later" }, 429);

/** Contract details, relayer and verifier health, open claims, plus every listed payTo's bond. */
stakeRoutes.get("/", async (c) => {
  try {
    const info = await stakeInfo();
    if (!info.enabled) return c.json({ ...info, sellers: [] });
    const payTos = [...new Set(listServices().map((s) => s.payTo.toLowerCase()))];
    const sellers = await Promise.all(
      payTos.map(async (payTo) => {
        const slashed = slashedTotal(payTo);
        return { payTo, ...(await stakeOf(payTo)), slashedCount: slashed.count, slashed: slashed.amount.toString() };
      }),
    );
    return c.json({ ...info, claims: claimSummary(), sellers });
  } catch (err) {
    return fail(c, err);
  }
});

stakeRoutes.get("/events", (c) => c.json({ events: listStakeEvents({ seller: c.req.query("seller") }) }));

/** Claims for verifiers and the UI. ?state=active | new | open | proposed | executed | vetoed | expired | rejected | not_slashable; ?seller= */
stakeRoutes.get("/claims", (c) => c.json({ claims: listClaims({ state: c.req.query("state"), seller: c.req.query("seller") }) }));

/** The evidence bundle exactly as stored, so its keccak256 is the hash in the URL. */
stakeRoutes.get("/evidence/:hash", (c) => {
  const hash = c.req.param("hash");
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return c.json({ error: "hash must be 0x + 64 hex characters" }, 400);
  const ev = getEvidence(hash);
  return ev ? c.body(ev.json, 200, { "Content-Type": "application/json" }) : c.json({ error: "no such evidence" }, 404);
});

/** A verifier's signature. Body: { type: "claim" | "veto", signature }. */
stakeRoutes.post("/claims/:id/signature", async (c) => {
  if (limited(c, "signature")) return tooMany(c);
  const b = await c.req.json().catch(() => ({}));
  if ((b.type !== "claim" && b.type !== "veto") || typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) {
    return c.json({ error: 'body needs type ("claim" or "veto") and a 65-byte hex signature' }, 400);
  }
  try {
    return c.json(await addSignature(Number(c.req.param("id")), b.type, b.signature));
  } catch (err) {
    return fail(c, err);
  }
});

/** The seller's rebuttal of a kind 2 claim. Body: { receipt: <X-Gandiva-Receipt value>, body: <raw response text> }. */
stakeRoutes.post("/claims/:id/rebuttal", bodyLimit({ maxSize: 2_500_000, onError: (c) => c.json({ error: "request too large" }, 413) }), async (c) => {
  if (limited(c, "rebuttal")) return tooMany(c);
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.receipt !== "string" || typeof b.body !== "string") return c.json({ error: "body needs receipt and body (strings)" }, 400);
  try {
    return c.json(await addRebuttal(Number(c.req.param("id")), { receipt: b.receipt, body: b.body }));
  } catch (err) {
    return fail(c, err);
  }
});

stakeRoutes.get("/:address", async (c) => {
  const address = c.req.param("address");
  if (!isAddress(address)) return c.json({ error: "address must be a 0x EVM address" }, 400);
  const slashed = slashedTotal(address);
  return c.json({
    enabled: stakeEnabled(),
    address,
    ...(await stakeOf(address, true)),
    slashedCount: slashed.count,
    slashed: slashed.amount.toString(),
  });
});

/** Typed data the seller signs in its wallet (no gas). Body: { seller, amount } with amount in USDC, e.g. "0.05". */
stakeRoutes.post("/prepare", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isAddress(body.seller)) return c.json({ error: "seller must be a 0x EVM address" }, 400);
  if (typeof body.amount !== "string" || !/^\d+(\.\d{1,6})?$/.test(body.amount)) return c.json({ error: 'amount is a USDC string such as "0.05"' }, 400);
  try {
    return c.json(prepareStake(body.seller, toUnits(body.amount)));
  } catch (err) {
    return fail(c, err);
  }
});

/** Relays a signed stake. Body: the prepared message fields plus the wallet's signature. */
stakeRoutes.post("/", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!isAddress(b.from) || ![b.value, b.validAfter, b.validBefore].every((x) => typeof x === "string" && /^\d+$/.test(x)) || !/^0x[0-9a-fA-F]{64}$/.test(b.nonce ?? "") || typeof b.signature !== "string") {
    return c.json({ error: "body needs from, value, validAfter, validBefore, nonce and signature" }, 400);
  }
  if (limited(c, "relay", b.from)) return tooMany(c);
  try {
    return c.json(await relayStake(b));
  } catch (err) {
    return fail(c, err);
  }
});

stakeRoutes.post("/unstake/prepare", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isAddress(body.seller)) return c.json({ error: "seller must be a 0x EVM address" }, 400);
  try {
    return c.json(await prepareUnstake(body.seller));
  } catch (err) {
    return fail(c, err);
  }
});

stakeRoutes.post("/unstake", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!isAddress(b.seller) || typeof b.deadline !== "string" || typeof b.signature !== "string") return c.json({ error: "body needs seller, deadline and signature" }, 400);
  if (limited(c, "relay", b.seller)) return tooMany(c);
  try {
    return c.json(await relayUnstake(b));
  } catch (err) {
    return fail(c, err);
  }
});

stakeRoutes.post("/withdraw", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!isAddress(b.seller)) return c.json({ error: "seller must be a 0x EVM address" }, 400);
  if (limited(c, "relay", b.seller)) return tooMany(c);
  try {
    return c.json(await withdrawFor(b.seller));
  } catch (err) {
    return fail(c, err);
  }
});

/** Typed data for naming the key that signs this seller's receipts. Body: { seller, signer }. */
stakeRoutes.post("/receipt-signer/prepare", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!isAddress(b.seller) || !isAddress(b.signer)) return c.json({ error: "seller and signer must be 0x EVM addresses" }, 400);
  try {
    return c.json(await prepareReceiptSigner(b.seller, b.signer));
  } catch (err) {
    return fail(c, err);
  }
});

/** Relays a signed SetReceiptSigner. Body: { seller, signer, deadline, signature }. */
stakeRoutes.post("/receipt-signer", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!isAddress(b.seller) || !isAddress(b.signer) || typeof b.deadline !== "string" || !/^\d+$/.test(b.deadline) || typeof b.signature !== "string") {
    return c.json({ error: "body needs seller, signer, deadline and signature" }, 400);
  }
  if (limited(c, "relay", b.seller)) return tooMany(c);
  try {
    return c.json(await relayReceiptSigner(b));
  } catch (err) {
    return fail(c, err);
  }
});
