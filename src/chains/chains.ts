import { createHash, randomUUID } from "node:crypto";
import type { Context } from "hono";
import { z } from "zod";
import { AgentWalletError, ensureAgentWallet, getAgentPayer, usdcBalance } from "../agents/wallet.js";
import { canonical } from "../buyer/catalogue.js";
import { buyFrom, Ctx, type PayFn, type RunState } from "../buyer/purchase.js";
import { resolveRef } from "../buyer/refs.js";
import { config, fromUnits, MAX_PRICE_UNITS } from "../config.js";
import { db } from "../db.js";
import { secretsConfigured } from "../crypto/secrets.js";
import { getHosted } from "../hosted/agents.js";
import { getService, registerForWallet, searchServices, slug, walletOwner, type Category, type Service, type ServiceWithReputation } from "../registry/store.js";
import { BRIEF_ID, briefOutput } from "../sellers/brief.js";
import { BudgetLedger } from "../x402/budget.js";
import { paidRoute, ServiceError } from "../x402/paidRoute.js";
import { validate, validateInput } from "../x402/schema.js";
import { addChainRun, chainStats, getChain, isChainService, listChainsByOwner, settleFailures, upsertChain, type Chain, type ChainStats, type ChainStep, type SkipIf, type Source } from "./store.js";

export const MIN_STEPS = 2;
export const MAX_STEPS = 3;
/** Requests one chain may handle at once: it pays its suppliers before the buyer's payment settles, so this bounds the float at risk. */
export const MAX_CONCURRENT = 2;
/** Below the buyer's 90 s paid-call timeout, so a slow chain fails cleanly (buyer not charged) instead of the buyer giving up mid-way. */
const CHAIN_TIMEOUT_MS = 80_000;

/** A form problem the seller can fix (status says which kind). */
export class ChainError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 429 | 502 | 503 = 400,
  ) {
    super(message);
  }
}

// ---- the form -------------------------------------------------------------------------------------------------------

const units = z.string().regex(/^\d+$/, "amounts are in USDC smallest units (6 decimals)");
const buyerSource = z.object({ from: z.literal("buyer"), field: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a buyer field name uses lower-case letters, digits and _ and starts with a letter") });
const stepRef = { step: z.number().int().min(1).max(MAX_STEPS), field: z.string().min(1).max(80) };
const source = z.discriminatedUnion("from", [
  buyerSource,
  z.object({ from: z.literal("fixed"), value: z.unknown() }),
  z.object({ from: z.literal("step"), ...stepRef, fallback: z.unknown().optional() }),
]);
const skipIf = z.object({
  when: z.discriminatedUnion("from", [buyerSource, z.object({ from: z.literal("step"), ...stepRef })]),
  test: z.enum(["empty", "not_empty", "equals"]),
  value: z.unknown().optional(),
});
const steps = z
  .array(z.object({ serviceId: z.string().min(1).max(64), input: z.record(z.string().min(1).max(80), source), skipIf: skipIf.optional() }))
  .min(MIN_STEPS, `a chain needs at least ${MIN_STEPS} steps`)
  .max(MAX_STEPS, `a chain can have at most ${MAX_STEPS} steps`);
const price = units.refine((p) => BigInt(p) > 0n && BigInt(p) <= MAX_PRICE_UNITS, "price must be > 0 and <= 100000 (0.10 USDC)");
const quoteForm = z.object({ id: z.string().regex(/^[a-z0-9-]{2,64}$/).optional(), price, subBudget: units, steps });
const chainForm = quoteForm.extend({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(10, "describe what the chain does (at least 10 characters); buyer agents read it").max(400),
});
const testForm = quoteForm.extend({ input: z.record(z.string(), z.unknown()) });

// ---- schema helpers -------------------------------------------------------------------------------------------------

type Schema = Record<string, any>;
const props = (s: Schema | undefined): Record<string, Schema> => (s && typeof s.properties === "object" && s.properties ? s.properties : {});
const requiredOf = (s: Schema | undefined): string[] => (Array.isArray(s?.required) ? s!.required : []);

function typesOf(s: Schema | undefined): Set<string> | null {
  if (!s) return null;
  if (typeof s.type === "string") return new Set([s.type]);
  if (Array.isArray(s.type)) return new Set(s.type);
  return null;
}
const takes = (target: Set<string>, t: string) => target.has(t) || (t === "integer" && target.has("number"));

/** Can a value of schema `src` fill a field of schema `tgt`? "wrap" = yes, as a one-item list. Unknown types are allowed (the seller still checks). */
export function fit(src: Schema | undefined, tgt: Schema | undefined): "ok" | "wrap" | null {
  const s = typesOf(src);
  const t = typesOf(tgt);
  if (!s || !t) return "ok";
  const real = [...s].filter((x) => x !== "null");
  if (!real.length) return null;
  if (real.every((x) => takes(t, x))) return "ok";
  if (t.has("array")) {
    const items = typesOf(tgt?.items);
    if (!items || real.every((x) => takes(items, x))) return "wrap";
  }
  return null;
}

const wantsList = (tgt: Schema | undefined) => Boolean(typesOf(tgt)?.has("array"));

// ---- planning a chain: validation plus the listing it becomes -------------------------------------------------------

export interface ChainPlan {
  steps: ChainStep[];
  services: Service[];
  category: Category;
  inputSchema: Schema;
  outputSchema: Schema;
  /** What one request costs at the chosen sellers' current prices, when no step is skipped. */
  cost: bigint;
  /** What it costs when every skippable step is skipped. */
  minCost: bigint;
}

const keyOf = (s: Service) => canonical([s.category, s.inputSchema, s.outputSchema]);
const isChainLike = (id: string) => id === BRIEF_ID || isChainService(id);

/** What a listing is, for the Marketplace tag: a chain hires and pays other sellers, an AI agent is a hosted LLM seller, the rest are data APIs. */
export type Kind = "chain" | "agent" | "data";
export function kindOf(serviceId: string): Kind {
  if (serviceId === BRIEF_ID || isChainService(serviceId)) return "chain";
  return getHosted(serviceId) ? "agent" : "data";
}

/** Checks the steps against the live registry and builds the chain's own input and output schemas. Throws ChainError. */
export function planChain(form: { steps: { serviceId: string; input: Record<string, Source>; skipIf?: SkipIf }[]; subBudget: string; price: string }, self?: string, lookup: (id: string) => Service | undefined = getService): ChainPlan {
  const services: Service[] = [];
  const buyer = new Map<string, { schema: Schema; required: boolean }>();
  for (const [i, step] of form.steps.entries()) {
    const n = i + 1;
    const svc = lookup(step.serviceId);
    if (!svc) throw new ChainError(`step ${n}: "${step.serviceId}" is not listed`);
    if (svc.id === self) throw new ChainError(`step ${n}: a chain cannot hire itself`);
    if (isChainLike(svc.id)) throw new ChainError(`step ${n}: ${svc.name} is an agent chain, and chains cannot hire other chains`);
    if (svc.verification !== "verified") throw new ChainError(`step ${n}: ${svc.name}'s 402 has not been verified against its listing (${svc.verification}), so a chain will not hire it`);
    const target = props(svc.inputSchema);
    const known = Object.keys(target);
    for (const field of Object.keys(step.input)) {
      if (known.length && !known.includes(field)) throw new ChainError(`step ${n}: ${svc.name} has no input field "${field}"`);
    }
    for (const field of requiredOf(svc.inputSchema)) {
      if (!step.input[field]) throw new ChainError(`step ${n}: choose where ${svc.name}'s required field "${field}" comes from`);
    }
    for (const [field, src] of Object.entries(step.input)) {
      const tgt = target[field];
      if (src.from === "fixed") {
        if (src.value === undefined) throw new ChainError(`step ${n}: give a fixed value for "${field}"`);
        const v = validate(tgt ?? {}, src.value);
        if (!v.ok) throw new ChainError(`step ${n}: the fixed value for "${field}" is not valid (${v.error})`);
      } else if (src.from === "step") {
        if (src.step >= n) throw new ChainError(`step ${n}: "${field}" can only use the output of an earlier step`);
        const prev = services[src.step - 1];
        const out = props(prev.outputSchema);
        if (!(src.field in out)) throw new ChainError(`step ${n}: step ${src.step} (${prev.name}) has no output field "${src.field}"`);
        if (!fit(out[src.field], tgt)) {
          throw new ChainError(`step ${n}: step ${src.step}'s "${src.field}" (${[...(typesOf(out[src.field]) ?? [])].join("/")}) cannot fill ${svc.name}'s "${field}" (${[...(typesOf(tgt) ?? [])].join("/")})`);
        }
        if (form.steps[src.step - 1].skipIf) {
          // That earlier step may be skipped, and then there is nothing to read: say what this field gets instead.
          if (src.fallback !== undefined) {
            const v = validate(tgt ?? {}, wantsList(tgt) && !Array.isArray(src.fallback) ? [src.fallback] : src.fallback);
            if (!v.ok) throw new ChainError(`step ${n}: the fallback for "${field}" is not valid (${v.error})`);
          } else if (requiredOf(svc.inputSchema).includes(field)) {
            throw new ChainError(`step ${n}: step ${src.step} can be skipped, so give "${field}" a fallback value for when it is`);
          }
        }
      } else {
        const schema = tgt ?? {};
        const seen = buyer.get(src.field);
        if (seen && canonical(seen.schema) !== canonical(schema)) throw new ChainError(`the buyer field "${src.field}" is used for two inputs of different types; give one of them another name`);
        buyer.set(src.field, { schema: seen?.schema ?? schema, required: Boolean(seen?.required) || requiredOf(svc.inputSchema).includes(field) });
      }
    }
    services.push(svc);
  }

  for (const [i, step] of form.steps.entries()) {
    const n = i + 1;
    const c = step.skipIf;
    if (!c) continue;
    const name = services[i].name;
    if (n === form.steps.length) throw new ChainError(`step ${n} (${name}) is the last step, so it cannot be skipped: the chain's answer comes from it`);
    if (c.when.from === "buyer") {
      if (!buyer.has(c.when.field)) throw new ChainError(`step ${n}: the skip condition uses the buyer field "${c.when.field}", but no step takes it from the buyer`);
    } else {
      if (c.when.step >= n) throw new ChainError(`step ${n}: the skip condition can only look at an earlier step`);
      const prev = services[c.when.step - 1];
      if (!(c.when.field in props(prev.outputSchema))) throw new ChainError(`step ${n}: the skip condition uses "${c.when.field}", which step ${c.when.step} (${prev.name}) does not return`);
    }
    if (c.test === "equals" && c.value === undefined) throw new ChainError(`step ${n}: give the value the skip condition compares with`);
  }

  const cost = services.reduce((sum, s) => sum + BigInt(s.price), 0n);
  const minCost = services.reduce((sum, s, i) => (form.steps[i].skipIf ? sum : sum + BigInt(s.price)), 0n);
  const subBudget = BigInt(form.subBudget);
  if (subBudget < cost) throw new ChainError(`the steps cost ${fromUnits(cost)} USDC per call at today's prices; the sub-budget (${fromUnits(subBudget)}) must cover that`);
  if (subBudget > BigInt(form.price)) throw new ChainError(`the sub-budget (${fromUnits(subBudget)} USDC) must not be more than your price (${fromUnits(form.price)}), or a call could lose you money`);

  const last = services[services.length - 1];
  const inputSchema = {
    type: "object",
    properties: Object.fromEntries([...buyer].map(([f, b]) => [f, b.schema])),
    required: [...buyer].filter(([, b]) => b.required).map(([f]) => f),
    additionalProperties: false,
  };
  const outputSchema = {
    type: "object",
    required: ["result", "steps", "hired", "cost_units"],
    properties: {
      result: last.outputSchema,
      steps: {
        type: "array",
        description: "What each hired seller returned, in order",
        items: { type: "object", required: ["service", "output"], properties: { service: { type: "string" }, output: {}, skipped: { type: "boolean", description: "true when the skip condition held and this step was not bought" } } },
      },
      hired: briefOutput.properties.hired,
      cost_units: briefOutput.properties.cost_units,
    },
  };
  return {
    steps: form.steps.map((s, i) => ({ serviceId: s.serviceId, input: s.input, ...(s.skipIf ? { skipIf: s.skipIf } : {}), key: keyOf(services[i]) })),
    services,
    category: last.category,
    inputSchema,
    outputSchema,
    cost,
    minCost,
  };
}

// ---- running a chain -------------------------------------------------------------------------------------------------

export interface ChainDeps {
  /** Pays one seller (the real thing is the owner's agent wallet SafePayer). */
  pay: PayFn;
  address: string;
  /** USDC held by the paying wallet, in units. */
  balance: () => Promise<bigint>;
  /** USDC held by any wallet (the buyer's), in units. Without it the buyer's balance is not checked. */
  payerBalance?: (address: string) => Promise<bigint>;
  /** All registry services, best-ranked first. */
  services: () => ServiceWithReputation[];
}

const inflight = new Map<string, number>();
/**
 * Buyers with a chain request running. The chain pays its suppliers before their payment settles, so one wallet firing
 * requests in parallel could drain floats faster than failed settlements can count against it: one at a time, across all chains.
 */
const activePayers = new Set<string>();
/** Owners whose chains are paying suppliers right now (one entry per running request). */
const payingOwners: string[] = [];
/** Is one of this wallet's chains paying from its agent wallet right now? (A withdrawal must wait for it.) */
export const hasActiveChain = (owner: string) => payingOwners.includes(owner.toLowerCase());

/** A chain pays its suppliers before the buyer's payment settles, so a payer whose payments keep failing to settle is refused. */
export const MAX_STRIKES = 3;
export const STRIKE_WINDOW_MS = 3_600_000;

/** What a failed request already paid for is kept briefly, so the same buyer retrying the same request does not pay those suppliers twice. */
export const CACHE_TTL_MS = 600_000;
const CACHE_MAX = 200;
interface CachedStep {
  at: number;
  service: string;
  category: string;
  data: unknown;
}
const stepCache = new Map<string, CachedStep>();

const cacheKey = (chain: Chain, payer: string, input: Record<string, unknown>, step: ChainStep, n: number) =>
  `${payer.toLowerCase()}|${chain.serviceId}|${n}|${createHash("sha256").update(canonical([input, step])).digest("hex")}`;

function cacheGet(key: string, now = Date.now()): CachedStep | undefined {
  const hit = stepCache.get(key);
  if (hit && now - hit.at >= CACHE_TTL_MS) {
    stepCache.delete(key);
    return undefined;
  }
  return hit;
}

function cachePut(key: string, value: CachedStep) {
  stepCache.delete(key);
  stepCache.set(key, value);
  while (stepCache.size > CACHE_MAX) stepCache.delete(stepCache.keys().next().value as string);
}

/** Test hook. */
export const clearStepCache = () => stepCache.clear();

/** Who is buying, and a place for runChain to report what it spent (kept up to date even when it throws). */
export interface RunContext {
  /** The buyer's wallet (from the signed, not yet settled, payment). Absent for the owner's test run. */
  payer?: string;
  /** The chain's price, in USDC units. */
  price?: bigint;
  tally?: { cost: bigint; stepsPaid: number; stepsCached: number };
}

/** Missing, null, blank text, an empty list or an empty object. (0 and false are real values.) */
export function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/** Does this step's skip condition hold? A field that is not there (for example from a step that was itself skipped) counts as empty. */
export function shouldSkip(c: SkipIf, results: Map<string, unknown>): boolean {
  let v: unknown;
  if (c.when.from === "buyer") v = (results.get("in") as Record<string, unknown>)[c.when.field];
  else {
    try {
      v = results.has(`s${c.when.step}`) ? resolveRef(`$s${c.when.step}.${c.when.field}`, results) : undefined;
    } catch {
      v = undefined;
    }
  }
  if (c.test === "empty") return isEmpty(v);
  if (c.test === "not_empty") return !isEmpty(v);
  return same(v, c.value);
}

/** Plain values match by their text ("5" equals 5), so a number typed into the Sell tab matches a number field; lists and objects match exactly. */
const same = (a: unknown, b: unknown) => {
  const plain = (x: unknown) => x === null || typeof x !== "object";
  if (a === undefined) return false;
  return plain(a) && plain(b) ? String(a) === String(b) : canonical(a) === canonical(b);
};

/** The input for one step, built from the buyer's request, fixed values and earlier outputs. */
function stepInput(step: ChainStep, results: Map<string, unknown>, target: Schema): Record<string, unknown> {
  const fields = props(target);
  const out: Record<string, unknown> = {};
  for (const [field, src] of Object.entries(step.input)) {
    let value: unknown;
    if (src.from === "fixed") value = src.value;
    else if (src.from === "step") {
      if (!results.has(`s${src.step}`)) {
        // That step was skipped: use the seller's fallback, or leave an optional field out.
        if (src.fallback === undefined) continue;
        value = src.fallback;
      } else value = resolveRef(`$s${src.step}.${src.field}`, results as Map<string, unknown>);
    } else {
      const given = results.get("in") as Record<string, unknown>;
      if (!(src.field in given)) continue; // an optional buyer field that was left out
      value = given[src.field];
    }
    out[field] = wantsList(fields[field]) && !Array.isArray(value) ? [value] : value;
  }
  return out;
}

/**
 * Does the job by hiring each step's seller in order, paying from the chain's wallet through the same price check, schema
 * check, budget and spend cap as Scout. A seller that misbehaves is swapped for a verified one doing the same job. Anything
 * that fails throws ServiceError before the buyer's payment settles, so the buyer is only charged for a finished job.
 */
export async function runChain(chain: Chain, input: Record<string, unknown>, deps: ChainDeps, opts: RunContext = {}) {
  const buyer = opts.payer?.toLowerCase();
  if (buyer && activePayers.has(buyer)) throw new ServiceError(`${opts.payer} already has an agent chain request running; try again when it finishes`, 429);
  const busy = inflight.get(chain.serviceId) ?? 0;
  if (busy >= MAX_CONCURRENT) throw new ServiceError(`this chain is already handling ${MAX_CONCURRENT} requests; try again in a moment`, 503);
  if (buyer) activePayers.add(buyer);
  inflight.set(chain.serviceId, busy + 1);
  payingOwners.push(chain.owner.toLowerCase());
  let run: RunState | undefined;
  let cachedSteps = 0;
  try {
    if (opts.payer) {
      const strikes = settleFailures(chain.serviceId, opts.payer, new Date(Date.now() - STRIKE_WINDOW_MS).toISOString());
      if (strikes >= MAX_STRIKES) {
        throw new ServiceError(`payments from ${opts.payer} failed to settle ${strikes} times in the last hour, so this chain will not start work for that wallet until that clears`, 429);
      }
    }

    let held: bigint;
    try {
      held = await deps.balance();
    } catch (err: any) {
      throw new ServiceError(`cannot check the chain's wallet balance: ${err?.message ?? err}`, 503);
    }
    const needed = chain.subBudget * BigInt(busy + 1);
    if (held < needed) throw new ServiceError(`this chain is out of float (${deps.address} holds ${fromUnits(held)} USDC, needs ${fromUnits(needed)}); its owner must add funds`, 503);

    // The chain pays its suppliers first and is paid when the buyer's payment settles: do not start for a wallet that cannot pay.
    if (opts.payer && opts.price !== undefined && deps.payerBalance) {
      let theirs: bigint;
      try {
        theirs = await deps.payerBalance(opts.payer);
      } catch (err: any) {
        throw new ServiceError(`cannot check the paying wallet's balance: ${err?.message ?? err}`, 503);
      }
      if (theirs < opts.price) throw new ServiceError(`the paying wallet holds ${fromUnits(theirs)} USDC but this chain costs ${fromUnits(opts.price)}; nothing was started`, 400);
    }

    run = {
      id: `chain-${randomUUID().slice(0, 8)}`,
      task: `agent chain ${chain.serviceId}`,
      budget: chain.subBudget.toString(),
      maxConcurrency: 1,
      state: "running",
      mode: "agent",
      dryRun: false,
      buyer: deps.address,
      log: [] as string[],
      purchases: [],
      startedAt: new Date().toISOString(),
    } as RunState;
    const ctx = new Ctx(run, new BudgetLedger(chain.subBudget), 1, deps.pay);
    const all = deps.services();
    const results = new Map<string, unknown>([["in", input]]);
    const outputs: { service: string; output: unknown; skipped?: boolean }[] = [];
    const hired: { service: string; category: string; status: string; paid: string; tx_hash?: string }[] = [];
    const keys: string[] = [];
    const isPaid = (p: { status: string }) => p.status === "paid" || p.status === "paid_output_rejected";
    const tally = () => {
      if (!opts.tally || !run) return;
      const paid = run.purchases.filter(isPaid);
      opts.tally.cost = paid.reduce((sum, p) => sum + BigInt(p.paid), 0n);
      opts.tally.stepsPaid = paid.length;
      opts.tally.stepsCached = cachedSteps;
    };

    for (const [i, step] of chain.steps.entries()) {
      const n = i + 1;
      if (step.skipIf && shouldSkip(step.skipIf, results)) {
        // Not bought and not paid; later steps see no result for it and use their fallbacks.
        outputs.push({ service: step.serviceId, output: null, skipped: true });
        continue;
      }
      const key = opts.payer ? cacheKey(chain, opts.payer, input, step, n) : undefined;
      if (key) keys.push(key);
      const hit = key ? cacheGet(key) : undefined;
      if (hit) {
        // Paid for by an earlier request of this same buyer that did not finish: no second payment to the supplier.
        results.set(`s${n}`, hit.data);
        outputs.push({ service: hit.service, output: hit.data });
        hired.push({ service: hit.service, category: hit.category, status: "cached", paid: "0" });
        cachedSteps++;
        tally();
        continue;
      }
      // The seller chose this step's MCP tool by name, and any other tool with the same schema may do the opposite.
      const named = all.find((s) => s.id === step.serviceId);
      const sameJob = (s: Service) => (s.access || named?.access ? s.id === step.serviceId : keyOf(s) === step.key);
      const ranked = all.filter((s) => s.verification === "verified" && s.id !== chain.serviceId && !isChainLike(s.id) && sameJob(s));
      if (!ranked.length) throw new ServiceError(`step ${n}: no verified seller for ${step.serviceId}'s job is listed right now`, 503);
      let callInput: Record<string, unknown>;
      try {
        callInput = stepInput(step, results, ranked[0].inputSchema);
      } catch (err: any) {
        throw new ServiceError(`step ${n}: could not build its input: ${err?.message ?? err}`, 502);
      }
      const ok = validateInput(ranked[0].inputSchema, callInput);
      if (!ok.ok) throw new ServiceError(`step ${n}: its input would be rejected by the seller (${ok.error})`, 502);
      const pool = `chain:${chain.serviceId}:${n}`;
      if (ranked.some((s) => s.id === step.serviceId)) ctx.preferred.set(pool, step.serviceId);
      const before = run.purchases.length;
      const out = await buyFrom(ctx, pool, ranked, `step ${n}`, callInput);
      tally();
      if (out.data === undefined) throw new ServiceError(`step ${n} failed: ${out.lastReason ?? out.stop ?? "no seller delivered"}`, 502);
      results.set(`s${n}`, out.data);
      outputs.push({ service: out.service ?? step.serviceId, output: out.data });
      const mine = run.purchases.slice(before).filter(isPaid);
      for (const p of mine) hired.push({ service: p.service, category: p.category, status: p.status, paid: p.paid, ...(p.txHash ? { tx_hash: p.txHash } : {}) });
      if (key) cachePut(key, { at: Date.now(), service: out.service ?? step.serviceId, category: mine[mine.length - 1]?.category ?? ranked[0].category, data: out.data });
    }

    // Delivered: the buyer gets this answer, so a later identical request is a new job and pays its suppliers afresh.
    for (const k of keys) stepCache.delete(k);
    return {
      result: outputs[outputs.length - 1].output,
      steps: outputs,
      hired,
      cost_units: run.purchases.filter(isPaid).reduce((sum, p) => sum + BigInt(p.paid), 0n).toString(),
    };
  } finally {
    if (buyer) activePayers.delete(buyer);
    payingOwners.splice(payingOwners.indexOf(chain.owner.toLowerCase()), 1);
    const left = (inflight.get(chain.serviceId) ?? 1) - 1;
    if (left > 0) inflight.set(chain.serviceId, left);
    else inflight.delete(chain.serviceId);
  }
}

/** Pays from the owner's agent wallet, under that wallet's own spend cap. */
function agentDeps(owner: string): ChainDeps {
  let payer: ReturnType<typeof getAgentPayer>;
  try {
    payer = getAgentPayer(owner);
  } catch (err: any) {
    throw new ServiceError(`the chain's wallet is not available: ${err?.message ?? err}`, 503);
  }
  return { pay: (...args) => payer.call(...args), address: payer.address, balance: () => usdcBalance(payer.address), payerBalance: usdcBalance, services: () => searchServices() };
}

/** POST /sellers/c/:id/run: the paid x402 route of one chain, built from its stored steps on every request. */
export async function chainRoute(c: Context) {
  const id = c.req.param("id") ?? "";
  const service = getService(id);
  const chain = getChain(id);
  if (!service || !chain || service.owner !== walletOwner(chain.owner)) return c.json({ error: "no such agent chain" }, 404);
  const price = BigInt(service.price);
  const tally = { cost: 0n, stepsPaid: 0, stepsCached: 0 };
  let payer: string | undefined;
  let failure: string | undefined;
  const route = paidRoute<Record<string, unknown>, unknown>({
    seller: id,
    description: service.description,
    price,
    payTo: service.payTo,
    inputSchema: service.inputSchema,
    outputSchema: service.outputSchema,
    timeoutMs: CHAIN_TIMEOUT_MS,
    handler: async (input, info) => {
      payer = info.payer;
      try {
        return await runChain(chain, input, agentDeps(chain.owner), { payer: info.payer, price, tally });
      } catch (err: any) {
        failure = err?.message ?? String(err);
        throw err;
      }
    },
  });
  const started = Date.now();
  const res = await route(c);
  // Only requests that got as far as running the handler have a payer; a 402 challenge or a replay is not a request to record.
  if (payer !== undefined || failure !== undefined || tally.stepsPaid > 0) {
    const settled = res.status === 200;
    addChainRun({
      serviceId: id,
      kind: "sale",
      payer,
      outcome: settled ? "ok" : "failed",
      stepsPaid: tally.stepsPaid,
      stepsCached: tally.stepsCached,
      cost: tally.cost,
      earned: settled ? price : 0n,
      error: settled ? undefined : (failure ?? `payment did not settle (HTTP ${res.status})`),
      latencyMs: Date.now() - started,
    });
  }
  return res;
}

// ---- the Sell tab ---------------------------------------------------------------------------------------------------

function agentWalletOf(wallet: string): string {
  // Without SECRETS_KEY the agent wallet's key cannot be read, so the chain could never pay its steps.
  if (!secretsConfigured()) throw new ChainError("this server has no SECRETS_KEY, so agent wallets (which pay a chain's steps) cannot be used yet", 503);
  try {
    return ensureAgentWallet(wallet);
  } catch (err) {
    if (err instanceof AgentWalletError) throw new ChainError(err.message, err.status);
    throw err;
  }
}

/** Creates or updates the signed-in wallet's chain. Earnings are paid into its agent wallet, which also pays the steps. */
export async function saveChain(raw: unknown, wallet: string): Promise<Service> {
  const f = chainForm.parse(raw);
  agentWalletOf(wallet);
  const id = f.id ?? slug(f.name);
  const existing = getService(id);
  if (existing?.owner === walletOwner(wallet) && !isChainService(id)) throw new ChainError(`"${id}" is already one of your other listings; choose another name`, 409);
  const plan = planChain(f, id);
  // One transaction: a listing saved without its chain row could never be saved again (it would look like another listing).
  return db.transaction(() => {
    const service = registerForWallet(
      {
        id,
        name: f.name,
        category: plan.category,
        endpoint: `${config.publicBaseUrl}/sellers/c/${id}/run`,
        method: "POST",
        price: f.price,
        description: f.description,
        inputSchema: plan.inputSchema,
        outputSchema: plan.outputSchema,
      },
      wallet,
      { payTo: agentWalletOf(wallet) },
    );
    upsertChain({ serviceId: service.id, owner: wallet, steps: plan.steps, subBudget: BigInt(f.subBudget) });
    return service;
  })();
}

/** Free: what the chain would cost and earn per call, and the listing it becomes. Nothing is saved or paid. */
export async function quoteChain(raw: unknown, wallet: string) {
  const f = quoteForm.parse(raw);
  const plan = planChain(f, f.id);
  const address = agentWalletOf(wallet);
  let balance: bigint | null = null;
  try {
    balance = await usdcBalance(address);
  } catch {
    // shown as unknown
  }
  const subBudget = BigInt(f.subBudget);
  return {
    steps: plan.services.map((s, i) => ({ serviceId: s.id, name: s.name, category: s.category, price: s.price, skippable: Boolean(f.steps[i].skipIf) })),
    cost: plan.cost.toString(),
    minCost: plan.minCost.toString(),
    subBudget: subBudget.toString(),
    price: f.price,
    margin: (BigInt(f.price) - plan.cost).toString(),
    category: plan.category,
    inputSchema: plan.inputSchema,
    outputSchema: plan.outputSchema,
    agentWallet: { address, balance: balance?.toString() ?? null, enough: balance === null ? null : balance >= subBudget },
  };
}

const TEST_LIMIT = 10;
const TEST_WINDOW_MS = 3_600_000;
const testLog = new Map<string, number[]>();

/** Owner-only trial of the chain in the form. It pays the real sellers from the agent wallet (not through x402 to itself). */
export async function testChain(raw: unknown, wallet: string, now = Date.now(), deps?: ChainDeps) {
  const f = testForm.parse(raw);
  const recent = (testLog.get(wallet) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
  if (recent.length >= TEST_LIMIT) throw new ChainError(`at most ${TEST_LIMIT} test runs per hour`, 429);
  const plan = planChain(f, f.id);
  const v = validateInput(plan.inputSchema, f.input);
  if (!v.ok) throw new ChainError(`the sample input is not valid: ${v.error}`);
  agentWalletOf(wallet);
  testLog.set(wallet, [...recent, now]);
  const started = Date.now();
  const tally = { cost: 0n, stepsPaid: 0, stepsCached: 0 };
  // A test of a chain that is already listed counts in that chain's history (as cost only); a draft has nowhere to keep it.
  const saved = f.id && getChain(f.id)?.owner === wallet.toLowerCase() ? f.id : undefined;
  const record = (outcome: "ok" | "failed", error?: string) =>
    saved && addChainRun({ serviceId: saved, kind: "test", outcome, stepsPaid: tally.stepsPaid, stepsCached: 0, cost: tally.cost, earned: 0n, error, latencyMs: Date.now() - started });
  try {
    const output = await runChain({ serviceId: f.id ?? `test-${wallet.toLowerCase()}`, owner: wallet, steps: plan.steps, subBudget: BigInt(f.subBudget) }, f.input, deps ?? agentDeps(wallet), { tally });
    record("ok");
    return { output, ms: Date.now() - started };
  } catch (err) {
    record("failed", (err as Error)?.message);
    if (err instanceof ServiceError) throw new ChainError(err.message, 502);
    throw err;
  }
}

/** What the Sell tab may show about a wallet's chains. */
export function listChainsFor(wallet: string): Record<string, { steps: Omit<ChainStep, "key">[]; subBudget: string; hires: string[]; stats: ChainStats }> {
  return Object.fromEntries(
    listChainsByOwner(wallet).map((c) => [
      c.serviceId,
      { steps: c.steps.map(({ serviceId, input, skipIf }) => ({ serviceId, input, ...(skipIf ? { skipIf } : {}) })), subBudget: c.subBudget.toString(), hires: c.steps.map((s) => s.serviceId), stats: chainStats(c.serviceId) },
    ]),
  );
}

/** For the Marketplace card: which sellers a chain hires, or null for an ordinary seller. */
export function chainInfo(serviceId: string): { hires: string[] } | null {
  if (serviceId === BRIEF_ID) return { hires: ["city-info", "fx-rates", "hindi-summary"] };
  const c = getChain(serviceId);
  return c ? { hires: c.steps.map((s) => s.serviceId) } : null;
}
