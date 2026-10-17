import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { currentUser } from "../auth/routes.js";
import { config, EXPLORER_TX, fromUnits } from "../config.js";
import { listWithdrawals } from "../agents/wallet.js";
import { chainInfo, listChainsFor } from "../chains/chains.js";
import { chainRoutes } from "../chains/routes.js";
import { isChainService } from "../chains/store.js";
import { listHostedFor } from "../hosted/agents.js";
import { hostedRoutes } from "../hosted/routes.js";
import { collectSales, sellerPorts } from "../sellers/supervisor.js";
import { stakeRoutes } from "../stake/routes.js";
import { endpointBlockedReason, verifyService } from "./probe.js";
import { groupServices } from "../buyer/catalogue.js";
import { stakeOf } from "../stake/index.js";
import { credibilityCached, credibilityFor, ProofError, proofMessage, submitPayToProof } from "./credibility.js";
import { deleteOwnedService, deleteService, explainRank, getService, listByOwner, listLedger, listSales, recentCalls, RegistryError, registerExternal, registerForWallet, reputationFor, searchServices, slug } from "./store.js";

export const registry = new Hono();

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

registry.get("/services", (c) => {
  const { category, maxPrice, sort } = c.req.query();
  return c.json({
    services: searchServices({ category, maxPrice, sort }).map((s) => {
      const cred = credibilityCached(s.id);
      return { ...s, credibility: cred ? { score: cred.score, level: cred.level } : null, chain: chainInfo(s.id) };
    }),
  });
});

registry.get("/services/:id", async (c) => {
  const s = getService(c.req.param("id"));
  if (!s) return c.json({ error: "service not found" }, 404);
  return c.json({ ...s, reputation: reputationFor(s.id), credibility: await credibilityFor(s.id) });
});

registry.get("/services/:id/credibility", async (c) => {
  const s = getService(c.req.param("id"));
  if (!s) return c.json({ error: "service not found" }, 404);
  return c.json({ serviceId: s.id, payTo: s.payTo, proofMessage: proofMessage(s), ...(await credibilityFor(s.id, true)) });
});

/** Proves control of the listing's payTo: body { signature } over the proofMessage, signed by the payTo wallet. */
registry.post("/services/:id/proof", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.signature !== "string") return c.json({ error: "signature is required" }, 400);
  try {
    await submitPayToProof(c.req.param("id"), body.signature);
    return c.json({ ok: true, credibility: await credibilityFor(c.req.param("id"), true) });
  } catch (err: any) {
    return c.json({ error: err instanceof ProofError ? err.message : "invalid signature" }, err?.message === "service not found" ? 404 : 400);
  }
});

/**
 * Side-by-side view of the sellers that compete for one job: every parameter the buyer ranks on, normalised for charts,
 * and for each neighbouring pair the rule that decided the order. ?category=data[&ids=a,b][&selected=id]
 */
registry.get("/compare", async (c) => {
  const { category, ids, selected } = c.req.query();
  if (!category || !["data", "inference", "scraping"].includes(category)) return c.json({ error: "category must be data, inference or scraping" }, 400);
  const all = searchServices({ category });
  // With a selected seller, compare it only with the sellers the buyer would treat as substitutes (same input and output schema).
  const group = selected ? groupServices(all).find((g) => g.memberIds.includes(selected)) : undefined;
  const wanted = ids ? new Set(ids.split(",")) : group ? new Set(group.memberIds) : null;
  const ranked = all.filter((s) => !wanted || wanted.has(s.id));
  const creds = await Promise.all(ranked.map((s) => credibilityFor(s.id)));
  const stakes = await Promise.all(ranked.map((s) => stakeOf(s.payTo)));
  const prices = ranked.map((s) => Number(s.price));
  const lats = ranked.map((s) => s.reputation.medianLatencyMs).filter((x): x is number => x !== null);
  const [minP, maxP] = [Math.min(...prices), Math.max(...prices)];
  const [minL, maxL] = [Math.min(...lats), Math.max(...lats)];
  const scale = (v: number, lo: number, hi: number) => (hi === lo ? 1 : 1 - (v - lo) / (hi - lo));
  const candidates = ranked.map((s, i) => ({
    rank: i + 1,
    id: s.id,
    name: s.name,
    owner: s.owner,
    payTo: s.payTo,
    price: s.price,
    priceUsdc: fromUnits(s.price),
    verification: s.verification,
    verificationNote: s.verificationNote,
    reputation: s.reputation,
    credibility: creds[i] ?? null,
    stake: stakes[i],
    history: recentCalls(s.id),
    // 0..1, higher is better for the buyer, for radar and bar charts.
    metrics: {
      reputation: s.reputation.score,
      successRate: s.reputation.successRate,
      cheapness: scale(Number(s.price), minP, maxP),
      speed: s.reputation.medianLatencyMs === null ? 0 : scale(s.reputation.medianLatencyMs, minL, maxL),
      credibility: (creds[i]?.score ?? 0) / 100,
      stake: Math.min(1, Number(stakes[i].staked) / 50_000),
    },
  }));
  const decisions = ranked.slice(1).map((s, i) => ({ ahead: ranked[i].id, behind: s.id, ...explainRank(ranked[i], s) }));
  const sel = selected ? ranked.find((s) => s.id === selected) : undefined;
  const selection = sel
    ? sel.id === ranked[0]?.id
      ? { id: sel.id, rank: 1, verdict: `${sel.name} is the buyer's first choice for ${category}.` }
      : { id: sel.id, rank: ranked.indexOf(sel) + 1, verdict: `${ranked[0].name} is tried before ${sel.name}: ${explainRank(ranked[0], sel).detail}.` }
    : null;
  return c.json({
    category,
    scope: group ? `sellers interchangeable with ${selected} (same input and output schema)` : `every ${category} seller`,
    otherInCategory: all.length - ranked.length,
    rules: [
      "Listings whose live 402 contradicts them go last.",
      "Higher reputation wins when scores differ by more than 5 points (time-weighted success rate).",
      "Otherwise the cheaper listing wins.",
      "Same price: higher credibility wins (proofs, stake, wallet history).",
      "Still tied: the faster median latency wins.",
    ],
    candidates,
    decisions,
    selection,
  });
});

const MAX_LISTING_BYTES = 32 * 1024;

registry.post(
  "/services",
  bodyLimit({ maxSize: MAX_LISTING_BYTES, onError: (c) => c.json({ error: `listing too large (max ${MAX_LISTING_BYTES} bytes)` }, 413) }),
  async (c) => {
    try {
      const body = await c.req.json();
      const blocked = typeof body?.endpoint === "string" ? await endpointBlockedReason(body.endpoint) : null;
      if (blocked) return c.json({ error: blocked }, 400);
      const listed = registerExternal(body);
      // The listing is accepted either way; the probe records whether its real 402 matches (see Verification).
      await verifyService(listed);
      return c.json(getService(listed.id), 201);
    } catch (err) {
      if (err instanceof ZodError) return c.json({ error: "invalid listing", issues: err.issues }, 400);
      if (err instanceof RegistryError) return c.json({ error: err.message }, err.status);
      return c.json({ error: "body must be valid JSON" }, 400);
    }
  },
);

// Signed-in sellers (Sell tab): list, update and delete their own listings. payTo is always the signed-in wallet.
const signedIn = (c: Context) => currentUser(c);

registry.get("/mine", (c) => {
  const me = signedIn(c);
  if (!me) return c.json({ error: "sign in with your wallet first" }, 401);
  return c.json({ address: me, services: listByOwner(me).map((s) => ({ ...s, reputation: reputationFor(s.id) })), agents: listHostedFor(me), chains: listChainsFor(me) });
});

registry.route("/mine/llm-agents", hostedRoutes);
registry.route("/mine/chains", chainRoutes);
registry.route("/stake", stakeRoutes);

registry.post(
  "/mine/services",
  bodyLimit({ maxSize: MAX_LISTING_BYTES, onError: (c) => c.json({ error: `listing too large (max ${MAX_LISTING_BYTES} bytes)` }, 413) }),
  async (c) => {
    const me = signedIn(c);
    if (!me) return c.json({ error: "sign in with your wallet first" }, 401);
    try {
      const body = await c.req.json();
      const blocked = typeof body?.endpoint === "string" ? await endpointBlockedReason(body.endpoint) : null;
      if (blocked) return c.json({ error: blocked }, 400);
      const id = typeof body?.id === "string" ? body.id : typeof body?.name === "string" ? slug(body.name) : "";
      if (id && isChainService(id)) return c.json({ error: `"${id}" is one of your agent chains; edit it with the agent chain form` }, 409);
      const listed = registerForWallet(body, me);
      await verifyService(listed);
      return c.json(getService(listed.id), 201);
    } catch (err) {
      if (err instanceof ZodError) return c.json({ error: "invalid listing", issues: err.issues }, 400);
      if (err instanceof RegistryError) return c.json({ error: err.message }, err.status);
      return c.json({ error: "body must be valid JSON" }, 400);
    }
  },
);

registry.delete("/mine/services/:id", (c) => {
  const me = signedIn(c);
  if (!me) return c.json({ error: "sign in with your wallet first" }, 401);
  const result = deleteOwnedService(c.req.param("id"), me);
  if (result === "deleted") return c.json({ ok: true });
  return result === "not_yours" ? c.json({ error: "this listing belongs to another wallet" }, 403) : c.json({ error: "service not found" }, 404);
});

registry.delete("/services/:id", (c) => {
  if (!config.adminToken) return c.json({ error: "deleting listings is disabled (ADMIN_TOKEN is not set)" }, 403);
  if (!safeEqual(c.req.header("x-admin-token") ?? "", config.adminToken)) return c.json({ error: "missing or wrong x-admin-token" }, 401);
  return deleteService(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "service not found" }, 404);
});

registry.get("/ledger", (c) => {
  const runId = c.req.query("runId");
  const rows = listLedger({ runId, buyer: c.req.query("buyer") }).map((r) => ({
    ...r,
    explorer: r.tx_hash ? EXPLORER_TX + r.tx_hash : null,
    listed_usdc: fromUnits(r.listed),
    asked_usdc: r.asked ? fromUnits(r.asked) : null,
    paid_usdc: fromUnits(r.paid),
  }));
  const charged = rows.filter((r) => r.status === "paid" || r.status === "paid_output_rejected");
  const totalPaid = charged.reduce((acc, r) => acc + BigInt(r.paid), 0n);
  const unconfirmed = rows.filter((r) => r.status === "unconfirmed");
  return c.json({ totalPaid: totalPaid.toString(), totalPaidUsdc: fromUnits(totalPaid), unconfirmedCount: unconfirmed.length, entries: rows });
});

// Money taken back out of agent wallets (outgoing transfers that are not seller payments); scripts/reconcile.ts needs them.
registry.get("/withdrawals", (c) => c.json({ withdrawals: listWithdrawals(c.req.query("buyer")) }));

registry.get("/sales", async (c) => {
  const rows = sellerPorts.size ? await collectSales(listSales(), sellerPorts) : listSales();
  return c.json({
    sales: rows.map((s) => ({ ...s, explorer: s.tx_hash ? EXPLORER_TX + s.tx_hash : null, amount_usdc: fromUnits(s.amount) })),
  });
});
