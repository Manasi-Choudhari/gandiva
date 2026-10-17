import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { z } from "zod";
import { AgentWalletError, ensureAgentWallet, getAgentPayer, usdcBalance } from "../agents/wallet.js";
import { canonical } from "../buyer/catalogue.js";
import { buyFrom, Ctx, type PayFn, type RunState } from "../buyer/purchase.js";
import { resolveRef } from "../buyer/refs.js";
import { config, fromUnits, MAX_PRICE_UNITS } from "../config.js";
import { secretsConfigured } from "../crypto/secrets.js";
import { getService, registerForWallet, searchServices, slug, walletOwner, type Category, type Service, type ServiceWithReputation } from "../registry/store.js";
import { BRIEF_ID, briefOutput } from "../sellers/brief.js";
import { BudgetLedger } from "../x402/budget.js";
import { paidRoute, ServiceError } from "../x402/paidRoute.js";
import { validate, validateInput } from "../x402/schema.js";
import { getChain, isChainService, listChainsByOwner, upsertChain, type Chain, type ChainStep, type Source } from "./store.js";

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
const source = z.discriminatedUnion("from", [
  z.object({ from: z.literal("buyer"), field: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a buyer field name uses lower-case letters, digits and _ and starts with a letter") }),
  z.object({ from: z.literal("fixed"), value: z.unknown() }),
  z.object({ from: z.literal("step"), step: z.number().int().min(1).max(MAX_STEPS), field: z.string().min(1).max(80) }),
]);
const steps = z
  .array(z.object({ serviceId: z.string().min(1).max(64), input: z.record(z.string().min(1).max(80), source) }))
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
  /** What one request costs at the chosen sellers' current prices. */
  cost: bigint;
}

const keyOf = (s: Service) => canonical([s.category, s.inputSchema, s.outputSchema]);
const isChainLike = (id: string) => id === BRIEF_ID || isChainService(id);

/** Checks the steps against the live registry and builds the chain's own input and output schemas. Throws ChainError. */
export function planChain(form: { steps: { serviceId: string; input: Record<string, Source> }[]; subBudget: string; price: string }, self?: string, lookup: (id: string) => Service | undefined = getService): ChainPlan {
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
      } else {
        const schema = tgt ?? {};
        const seen = buyer.get(src.field);
        if (seen && canonical(seen.schema) !== canonical(schema)) throw new ChainError(`the buyer field "${src.field}" is used for two inputs of different types; give one of them another name`);
        buyer.set(src.field, { schema: seen?.schema ?? schema, required: Boolean(seen?.required) || requiredOf(svc.inputSchema).includes(field) });
      }
    }
    services.push(svc);
  }

  const cost = services.reduce((sum, s) => sum + BigInt(s.price), 0n);
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
        items: { type: "object", required: ["service", "output"], properties: { service: { type: "string" }, output: {} } },
      },
      hired: briefOutput.properties.hired,
      cost_units: briefOutput.properties.cost_units,
    },
  };
  return {
    steps: form.steps.map((s, i) => ({ serviceId: s.serviceId, input: s.input, key: keyOf(services[i]) })),
    services,
    category: last.category,
    inputSchema,
    outputSchema,
    cost,
  };
}

// ---- running a chain -------------------------------------------------------------------------------------------------

export interface ChainDeps {
  /** Pays one seller (the real thing is the owner's agent wallet SafePayer). */
  pay: PayFn;
  address: string;
  /** USDC held by the paying wallet, in units. */
  balance: () => Promise<bigint>;
  /** All registry services, best-ranked first. */
  services: () => ServiceWithReputation[];
}

const inflight = new Map<string, number>();

/** The input for one step, built from the buyer's request, fixed values and earlier outputs. */
function stepInput(step: ChainStep, results: Map<string, unknown>, target: Schema): Record<string, unknown> {
  const fields = props(target);
  const out: Record<string, unknown> = {};
  for (const [field, src] of Object.entries(step.input)) {
    let value: unknown;
    if (src.from === "fixed") value = src.value;
    else if (src.from === "step") value = resolveRef(`$s${src.step}.${src.field}`, results as Map<string, unknown>);
    else {
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
export async function runChain(chain: Chain, input: Record<string, unknown>, deps: ChainDeps) {
  const busy = inflight.get(chain.serviceId) ?? 0;
  if (busy >= MAX_CONCURRENT) throw new ServiceError(`this chain is already handling ${MAX_CONCURRENT} requests; try again in a moment`, 503);
  inflight.set(chain.serviceId, busy + 1);
  try {
    let held: bigint;
    try {
      held = await deps.balance();
    } catch (err: any) {
      throw new ServiceError(`cannot check the chain's wallet balance: ${err?.message ?? err}`, 503);
    }
    const needed = chain.subBudget * BigInt(busy + 1);
    if (held < needed) throw new ServiceError(`this chain is out of float (${deps.address} holds ${fromUnits(held)} USDC, needs ${fromUnits(needed)}); its owner must add funds`, 503);

    const run = {
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
    const outputs: { service: string; output: unknown }[] = [];

    for (const [i, step] of chain.steps.entries()) {
      const n = i + 1;
      const ranked = all.filter((s) => s.verification === "verified" && s.id !== chain.serviceId && !isChainLike(s.id) && keyOf(s) === step.key);
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
      const out = await buyFrom(ctx, pool, ranked, `step ${n}`, callInput);
      if (out.data === undefined) throw new ServiceError(`step ${n} failed: ${out.lastReason ?? out.stop ?? "no seller delivered"}`, 502);
      results.set(`s${n}`, out.data);
      outputs.push({ service: out.service ?? step.serviceId, output: out.data });
    }

    const paid = run.purchases.filter((p) => p.status === "paid" || p.status === "paid_output_rejected");
    return {
      result: outputs[outputs.length - 1].output,
      steps: outputs,
      hired: paid.map((p) => ({ service: p.service, category: p.category, status: p.status, paid: p.paid, ...(p.txHash ? { tx_hash: p.txHash } : {}) })),
      cost_units: paid.reduce((sum, p) => sum + BigInt(p.paid), 0n).toString(),
    };
  } finally {
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
  return { pay: (...args) => payer.call(...args), address: payer.address, balance: () => usdcBalance(payer.address), services: () => searchServices() };
}

/** POST /sellers/c/:id/run: the paid x402 route of one chain, built from its stored steps on every request. */
export async function chainRoute(c: Context) {
  const id = c.req.param("id") ?? "";
  const service = getService(id);
  const chain = getChain(id);
  if (!service || !chain || service.owner !== walletOwner(chain.owner)) return c.json({ error: "no such agent chain" }, 404);
  const route = paidRoute<Record<string, unknown>, unknown>({
    seller: id,
    description: service.description,
    price: BigInt(service.price),
    payTo: service.payTo,
    inputSchema: service.inputSchema,
    outputSchema: service.outputSchema,
    timeoutMs: CHAIN_TIMEOUT_MS,
    handler: async (input) => runChain(chain, input, agentDeps(chain.owner)),
  });
  return route(c);
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
    steps: plan.services.map((s) => ({ serviceId: s.id, name: s.name, category: s.category, price: s.price })),
    cost: plan.cost.toString(),
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
  try {
    const output = await runChain({ serviceId: f.id ?? `test-${wallet.toLowerCase()}`, owner: wallet, steps: plan.steps, subBudget: BigInt(f.subBudget) }, f.input, deps ?? agentDeps(wallet));
    return { output, ms: Date.now() - started };
  } catch (err) {
    if (err instanceof ServiceError) throw new ChainError(err.message, 502);
    throw err;
  }
}

/** What the Sell tab may show about a wallet's chains. */
export function listChainsFor(wallet: string): Record<string, { steps: Omit<ChainStep, "key">[]; subBudget: string; hires: string[] }> {
  return Object.fromEntries(
    listChainsByOwner(wallet).map((c) => [c.serviceId, { steps: c.steps.map(({ serviceId, input }) => ({ serviceId, input })), subBudget: c.subBudget.toString(), hires: c.steps.map((s) => s.serviceId) }]),
  );
}

/** For the Marketplace card: which sellers a chain hires, or null for an ordinary seller. */
export function chainInfo(serviceId: string): { hires: string[] } | null {
  if (serviceId === BRIEF_ID) return { hires: ["city-info", "fx-rates", "hindi-summary"] };
  const c = getChain(serviceId);
  return c ? { hires: c.steps.map((s) => s.serviceId) } : null;
}
