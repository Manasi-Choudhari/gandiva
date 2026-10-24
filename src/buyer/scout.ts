import { randomUUID } from "node:crypto";
import { config, EXPLORER_TX, toUnits } from "../config.js";
import { db } from "../db.js";
import { chatWith, type PlannerLlm } from "../llm.js";
import { agentMayPick, blindMayPick, getService, searchServices, type Category, type Service } from "../registry/store.js";
import { BudgetLedger } from "../x402/budget.js";
import { validateInput } from "../x402/schema.js";
import { SafePayer } from "../x402/safePayer.js";
import { runAgent } from "./agent.js";
import { planTask, type TaskPlan } from "./planner.js";
import { buyFrom, Ctx, describePurchase, usd, type RunState } from "./purchase.js";

export type { Purchase, RunState } from "./purchase.js";

const runs = new Map<string, RunState>();
let payer: SafePayer | null = null;

export function getPayer(): SafePayer {
  if (!config.buyerPrivateKey) throw new Error("BUYER_PRIVATE_KEY is not set; run npm run wallets:new");
  payer ??= new SafePayer(config.buyerPrivateKey);
  return payer;
}

export const MAX_RUNS = 500;
/** Keeps a run for /buyer/runs. Past MAX_RUNS the oldest finished ones go: each holds its whole log and results, and dry runs are free to start. */
export function rememberRun(run: RunState) {
  runs.set(run.id, run);
  for (const [id, r] of runs) {
    if (runs.size <= MAX_RUNS) break;
    if (r.state !== "running") runs.delete(id); // a Map iterates oldest first
  }
}

export const MAX_SAVED_RUNS = 1000;
/** Writes a run's whole state so its results outlive a restart. Past MAX_SAVED_RUNS the oldest lose theirs, as dry runs are free to start. */
function saveRun(run: RunState) {
  try {
    db.prepare("UPDATE runs SET state = ?, finished_at = ?, run_json = ? WHERE id = ?").run(run.state, run.finishedAt ?? null, JSON.stringify({ ...run, inflight: undefined }), run.id);
    db.prepare("UPDATE runs SET run_json = NULL WHERE run_json IS NOT NULL AND id NOT IN (SELECT id FROM runs WHERE run_json IS NOT NULL ORDER BY ts DESC LIMIT ?)").run(MAX_SAVED_RUNS);
  } catch (err: any) {
    console.error(`could not save run ${run.id}: ${err?.message ?? err}`);
  }
}

export function getRun(id: string): RunState | undefined {
  const live = runs.get(id);
  if (live) return live;
  const row = db.prepare("SELECT run_json FROM runs WHERE id = ?").get(id) as { run_json: string | null } | undefined;
  return row?.run_json ? (JSON.parse(row.run_json) as RunState) : undefined;
}

/** Does this user have a paying run in progress? (A withdrawal must wait for it.) */
export const hasActiveRun = (owner: string) => [...runs.values()].some((r) => r.owner === owner.toLowerCase() && r.state === "running" && !r.dryRun);

export function listRuns(owner: string): RunState[] {
  const me = owner.toLowerCase();
  const saved = db.prepare("SELECT run_json FROM runs WHERE owner = ? AND run_json IS NOT NULL ORDER BY ts DESC LIMIT 50").all(me) as { run_json: string }[];
  const byId = new Map(saved.map((r) => JSON.parse(r.run_json) as RunState).map((r) => [r.id, r]));
  for (const r of runs.values()) if (r.owner === me) byId.set(r.id, r); // memory holds the latest state of a live run
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
}

/**
 * Called once on boot: a run still marked running died with the last process. Its purchases are on the ledger (the
 * resolver settles any left unconfirmed), so what it spent comes from there.
 */
export function markInterruptedRuns(now = new Date().toISOString()): number {
  const stuck = db.prepare("SELECT id, run_json FROM runs WHERE state = 'running'").all() as { id: string; run_json: string | null }[];
  for (const { id, run_json } of stuck) {
    if (!run_json) {
      db.prepare("UPDATE runs SET state = 'interrupted', finished_at = ? WHERE id = ?").run(now, id);
      continue;
    }
    const run = JSON.parse(run_json) as RunState;
    const paid = db.prepare("SELECT paid FROM ledger WHERE run_id = ? AND status IN ('paid','paid_output_rejected')").all(id) as { paid: string }[];
    const spent = paid.reduce((sum, row) => sum + BigInt(row.paid), 0n);
    const budget = BigInt(run.budget);
    run.state = "interrupted";
    run.spent = spent.toString();
    run.remaining = (spent < budget ? budget - spent : 0n).toString();
    run.finishedAt = now;
    run.explanation = "The server restarted while this run was working, so it stopped here. What it paid for is on the ledger; a payment left unconfirmed is checked against the chain automatically.";
    run.log.push("interrupted: the server restarted during this run");
    saveRun(run);
  }
  return stuck.length;
}

// The shared demo wallet pays for anonymous runs, judge calls and the CLI; a signed-in user's run pays with their own agent wallet.
const payWith = (payer: SafePayer) => (...args: Parameters<SafePayer["call"]>) => payer.call(...args);
const pay = (...args: Parameters<SafePayer["call"]>) => getPayer().call(...args);

/**
 * The built-in books pipeline needs one specific job per category, and the marketplace now has several sellers per
 * category (weather, sentiment), so each purchase is limited to sellers that actually do that job.
 */
const props = (s: Service, side: "inputSchema" | "outputSchema") => ((s[side] as any)?.properties ?? {}) as Record<string, any>;
const POOLS = {
  scrape: (s: Service) => s.category === "scraping",
  fx: (s: Service) => s.category === "data" && "from" in props(s, "inputSchema") && "to" in props(s, "inputSchema"),
  hindi: (s: Service) => s.category === "inference" && props(s, "outputSchema").language?.const === "hi",
};
type Pool = keyof typeof POOLS;
const poolServices = (pool: Pool) => searchServices().filter(POOLS[pool]).filter(blindMayPick);

function buy(ctx: Ctx, pool: Pool, step: string, input: Record<string, unknown>) {
  return buyFrom(ctx, pool, poolServices(pool), step, input);
}

function matchesRating(rating: number, f: TaskPlan["rating"]) {
  if (!f) return true;
  return f.op === "eq" ? rating === f.value : f.op === "gte" ? rating >= f.value : rating <= f.value;
}

function cheapestPrice(pool: Pool): bigint {
  const list = poolServices(pool);
  return list.length ? list.reduce((m, s) => (BigInt(s.price) < m ? BigInt(s.price) : m), BigInt(list[0].price)) : 0n;
}

export interface StartOptions {
  task: string;
  budget: string;
  maxConcurrency?: number;
  /** Plan and quote only: nothing is paid. */
  dryRun?: boolean;
  /** auto (default): agent first, books pipeline as fallback. agent: never fall back. legacy: books pipeline only. */
  mode?: "auto" | "agent" | "legacy";
  /** Pays for the run instead of the shared demo wallet (a signed-in user's agent wallet). */
  payer?: SafePayer;
  /** Signed-in user who owns the run (lower-case wallet address). */
  owner?: string;
  /** The signed-in user's own Ollama settings for planning. Kept out of the run, which is shown to the browser. */
  llm?: PlannerLlm;
}

const defaultMode = (): NonNullable<StartOptions["mode"]> => {
  const m = (process.env.SCOUT_MODE ?? "auto").toLowerCase();
  return m === "agent" || m === "legacy" ? m : "auto";
};

export function startTask(opts: StartOptions): RunState {
  const budgetUnits = toUnits(opts.budget);
  if (budgetUnits <= 0n || budgetUnits > toUnits("1")) throw new Error("budget must be between 0 and 1 USDC");
  const mode = opts.mode ?? defaultMode();
  const payer = opts.payer ?? getPayer();
  const run: RunState = {
    id: randomUUID().slice(0, 8),
    task: opts.task,
    budget: budgetUnits.toString(),
    maxConcurrency: Math.min(Math.max(1, opts.maxConcurrency ?? 3), 10),
    state: "running",
    mode: mode === "legacy" ? "legacy" : "agent",
    dryRun: Boolean(opts.dryRun),
    buyer: payer.address,
    owner: opts.owner,
    log: [],
    purchases: [],
    startedAt: new Date().toISOString(),
  };
  rememberRun(run);
  db.prepare("INSERT INTO runs (id, ts, task, budget, state, owner, run_json) VALUES (?,?,?,?,?,?,?)").run(run.id, run.startedAt, run.task, run.budget, run.state, run.owner ?? null, JSON.stringify(run));
  executeTask(run, mode, payer, opts.llm)
    .catch((err) => {
      run.state = "failed";
      run.log.push(`fatal: ${err?.message ?? err}`);
      run.finishedAt = new Date().toISOString();
    })
    .finally(() => saveRun(run));
  return run;
}

const looksLikeBooks = (task: string) => /toscrape|(^|[^a-z])books?([^a-z]|$)/i.test(task);

/** Parts of a task the built-in books pipeline cannot do; it must not quietly answer only the books part. */
export const beyondBooks = (task: string): string | undefined => {
  const hit = task.match(/weather|temperature|forecast|climate|wind speed|time ?zone|population|sentiment|positive|negative|tone of|mood/i);
  return hit?.[0].toLowerCase();
};

async function executeTask(run: RunState, mode: NonNullable<StartOptions["mode"]>, payer: SafePayer, llm?: PlannerLlm) {
  const budget = new BudgetLedger(BigInt(run.budget));
  const ctx = new Ctx(run, budget, run.maxConcurrency, payWith(payer));
  ctx.log(`${run.dryRun ? "DRY RUN (nothing will be paid). " : ""}budget ${usd(run.budget)} USDC, max_concurrency ${run.maxConcurrency}, buyer ${payer.address}${run.owner ? " (your agent wallet)" : ""}`);

  if (llm) ctx.log(`planning with your own Ollama key (model ${llm.model} at ${llm.host})`);

  if (mode !== "legacy") {
    const outcome = await runAgent(ctx, {
      chat: chatWith(llm, { json: true, timeoutMs: 60_000, temperature: 0 }),
      services: () => searchServices().filter(agentMayPick),
    });
    if (outcome.handled) {
      run.finishedAt = new Date().toISOString();
      ctx.log(`done: ${run.state}. spent ${usd(run.spent ?? "0")} USDC, ${usd(run.remaining ?? run.budget)} left`);
      return;
    }
    ctx.log(`agent could not plan this task: ${outcome.reason}`);
    const extra = mode === "auto" ? beyondBooks(run.task) : undefined;
    if (mode === "agent" || !looksLikeBooks(run.task) || extra) {
      run.state = "failed";
      run.explanation = `Nothing was bought: ${outcome.reason}.${mode === "auto" ? (extra ? ` The built-in fallback only does book prices and Hindi summaries, so it would silently skip the "${extra}" part of your task; try again when the planner LLM is back.` : " The built-in fallback only understands book-price tasks on books.toscrape.com.") : ""}`;
      run.spent = "0";
      run.remaining = run.budget;
      run.finishedAt = new Date().toISOString();
      ctx.log("stopped: no plan, nothing bought");
      return;
    }
    ctx.log("falling back to the built-in books pipeline");
    run.mode = "legacy";
  }
  await executeLegacy(run, ctx, budget, llm);
}

async function executeLegacy(run: RunState, ctx: Ctx, budget: BudgetLedger, llm?: PlannerLlm) {
  const { plan, planner, notes } = await planTask(run.task, llm);
  run.plan = plan;
  run.planner = planner;
  notes.forEach((n) => ctx.log(n));
  ctx.log(`plan (${planner}): ${JSON.stringify(plan)}`);

  const pages = Array.from({ length: plan.pages.to - plan.pages.from + 1 }, (_, i) => plan.pages.from + i);
  const needFx = plan.currency !== "GBP";
  const summaryCalls = plan.summarise ? Math.ceil(plan.limit / 2) : 0;
  const estimate = BigInt(pages.length) * cheapestPrice("scrape") + (needFx ? cheapestPrice("fx") : 0n) + BigInt(summaryCalls) * cheapestPrice("hindi");
  ctx.log(
    `quote: ${pages.length} page scrape(s) + ${needFx ? 1 : 0} FX call + ${summaryCalls} summary call(s) (2 texts per call) >= ${usd(estimate)} USDC at the cheapest listed prices`,
  );
  if (estimate > budget.budget) ctx.log(`warning: budget ${usd(budget.budget)} is below the cheapest possible cost ${usd(estimate)}; buying what fits, then stopping`);
  if (run.dryRun) {
    run.state = estimate > budget.budget ? "needs_more_budget" : "completed";
    run.spent = "0";
    run.remaining = run.budget;
    run.result = { answer: `Dry run: nothing was bought. The built-in books pipeline would cost at least ${usd(estimate)} USDC.`, outputs: {}, dryRun: true };
    run.explanation = `Dry run: nothing was paid. Plan: ${JSON.stringify(plan)}. Minimum cost ${usd(estimate)} USDC against a budget of ${usd(run.budget)} USDC.`;
    run.finishedAt = new Date().toISOString();
    return;
  }

  const fxPromise = needFx ? buy(ctx, "fx", `fx GBP->${plan.currency}`, { from: "GBP", to: plan.currency }) : Promise.resolve({ data: { rate: 1, from: "GBP", to: "GBP", date: "" } });

  // Probe the first page alone so a bad seller is discovered once, then fan out in parallel.
  const pageResults: Record<number, any> = {};
  let blocked = false;
  const scrapePage = async (p: number) => {
    const r = await buy(ctx, "scrape", `scrape page ${p}`, { page: p });
    if (r.data) pageResults[p] = r.data;
    if (r.budgetBlocked) blocked = true;
  };
  await scrapePage(pages[0]);
  await Promise.all(pages.slice(1).map(scrapePage));
  const fx = await fxPromise;
  if ((fx as any).budgetBlocked) blocked = true;

  const gotPages = pages.filter((p) => pageResults[p]);
  const missingPages = pages.filter((p) => !pageResults[p]);
  const books = gotPages.flatMap((p) => pageResults[p].books as any[]);
  const picked = books
    .filter((b) => matchesRating(b.rating, plan.rating))
    .sort((a, b) => (plan.sort === "asc" ? a.price_gbp - b.price_gbp : b.price_gbp - a.price_gbp))
    .slice(0, plan.limit);
  const rate: number | undefined = fx.data?.rate;
  ctx.log(`combined ${books.length} books from ${gotPages.length} page(s); ${picked.length} match the filter`);

  const summaries: (string | null)[] = picked.map(() => null);
  let summaryCallsDone = 0;
  if (plan.summarise && picked.length) {
    const chunks: number[][] = [];
    for (let i = 0; i < picked.length; i += 2) chunks.push([i, i + 1].filter((j) => j < picked.length));
    await Promise.all(
      chunks.map(async (idx, n) => {
        const texts = idx.map((j) => (picked[j].description || picked[j].title).slice(0, 6000));
        const r = await buy(ctx, "hindi", `hindi summary batch ${n + 1}`, { texts });
        if (r.budgetBlocked) blocked = true;
        if (r.data?.summaries) {
          summaryCallsDone++;
          idx.forEach((j, k) => (summaries[j] = r.data.summaries[k]?.summary ?? null));
        }
      }),
    );
  }

  run.result = {
    currency: plan.currency,
    fxRate: rate ?? null,
    fxDate: fx.data?.date ?? null,
    pagesScraped: gotPages,
    pagesMissing: missingPages,
    books: picked.map((b, i) => ({
      title: b.title,
      rating: b.rating,
      price_gbp: b.price_gbp,
      [`price_${plan.currency.toLowerCase()}`]: rate !== undefined ? Math.round(b.price_gbp * rate * 100) / 100 : null,
      url: b.url,
      summary_hi: summaries[i],
    })),
  };

  run.spent = budget.spent.toString();
  run.remaining = (budget.budget - budget.spent).toString();
  const incomplete = missingPages.length > 0 || rate === undefined || (plan.summarise && summaries.some((s) => s === null));
  if (blocked) {
    const remainingCost =
      BigInt(missingPages.length) * cheapestPrice("scrape") +
      (needFx && rate === undefined ? cheapestPrice("fx") : 0n) +
      BigInt(Math.max(0, summaryCalls - summaryCallsDone)) * cheapestPrice("hindi");
    const shortfall = remainingCost > budget.budget - budget.spent ? remainingCost - (budget.budget - budget.spent) : 0n;
    run.state = "needs_more_budget";
    ctx.log(`stopped: budget exhausted. Spent ${usd(budget.spent)} of ${usd(budget.budget)} USDC. Need about ${usd(shortfall > 0n ? shortfall : remainingCost)} USDC more to finish.`);
  } else run.state = incomplete ? "partial" : "completed";

  run.explanation = explain(run, plan);
  run.finishedAt = new Date().toISOString();
  ctx.log(`done: ${run.state}. spent ${usd(run.spent)} USDC, ${usd(run.remaining)} left`);
}

function explain(run: RunState, plan: TaskPlan): string {
  const lines: string[] = [];
  const paid = run.purchases.filter((p) => p.status === "paid" || p.status === "paid_output_rejected");
  lines.push(
    `Task: ${plan.sort === "asc" ? "cheapest" : "most expensive"} ${plan.limit} book(s)${plan.rating ? ` with rating ${plan.rating.op === "eq" ? "=" : plan.rating.op === "gte" ? ">=" : "<="} ${plan.rating.value}` : ""} on pages ${plan.pages.from}-${plan.pages.to}, priced in ${plan.currency}${plan.summarise ? ", with Hindi summaries" : ""}.`,
  );
  lines.push(`Outcome: ${run.state}. Spent ${usd(run.spent ?? "0")} of ${usd(run.budget)} USDC across ${paid.length} paid call(s); ${usd(run.remaining ?? run.budget)} USDC left.`);
  for (const p of run.purchases) lines.push(describePurchase(p));
  if (plan.summarise) lines.push(`Summaries were batched 2 texts per call (${Math.ceil(plan.limit / 2)} call(s) instead of ${plan.limit}) to save budget.`);
  return lines.join("\n");
}

/** Buy one call in a category with reputation-ranked failover (e.g. junk output -> next seller). */
export async function buyCategory(opts: { category: Category; input: Record<string, unknown>; budget: string; maxConcurrency?: number; prefer?: string }) {
  const run: RunState = {
    id: `buy-${randomUUID().slice(0, 6)}`,
    task: `buy ${opts.category} ${JSON.stringify(opts.input)}`,
    budget: toUnits(opts.budget).toString(),
    maxConcurrency: opts.maxConcurrency ?? 1,
    state: "running",
    mode: "agent",
    dryRun: false,
    log: [],
    purchases: [],
    startedAt: new Date().toISOString(),
  };
  rememberRun(run);
  const budget = new BudgetLedger(BigInt(run.budget));
  // Only sellers whose listed input fits the request can do this job (a category now holds different kinds of work).
  const fits = searchServices({ category: opts.category }).filter((s) => blindMayPick(s) && validateInput(s.inputSchema, structuredClone(opts.input)).ok);
  const ctx = new Ctx(run, budget, run.maxConcurrency, pay);
  // A caller may name a seller to try first; it still has to pass every check, and failing over works as usual.
  if (opts.prefer && fits.some((s) => s.id === opts.prefer)) ctx.preferred.set(opts.category, opts.prefer);
  const r = await buyFrom(ctx, opts.category, fits, `buy ${opts.category}`, opts.input);
  run.state = r.data ? "completed" : r.budgetBlocked ? "needs_more_budget" : "failed";
  run.spent = budget.spent.toString();
  run.remaining = (budget.budget - budget.spent).toString();
  run.result = r.data ?? null;
  run.finishedAt = new Date().toISOString();
  return run;
}

/** Direct paid call to any registry service (used by judge tests and interop with external sellers). */
export async function buyOnce(opts: { serviceId: string; input: Record<string, unknown>; budget: string; timeoutMs?: number }) {
  const service = getService(opts.serviceId);
  if (!service) throw new Error(`service ${opts.serviceId} not found`);
  const budget = new BudgetLedger(toUnits(opts.budget));
  // A short timeout lets tests provoke "no answer after signing"; clamp so a caller cannot disable the safety net.
  const timeoutMs = opts.timeoutMs ? Math.min(Math.max(opts.timeoutMs, 1_000), 90_000) : undefined;
  const r = await getPayer().call(service, opts.input, { budget, runId: `direct-${randomUUID().slice(0, 6)}`, timeoutMs });
  return { ...r, paid: r.paid.toString(), asked: r.asked?.toString(), explorer: r.txHash ? EXPLORER_TX + r.txHash : undefined };
}
