import pLimit from "p-limit";
import { EXPLORER_TX, fromUnits } from "../config.js";
import type { Category, Service, ServiceWithReputation } from "../registry/store.js";
import type { BudgetLedger } from "../x402/budget.js";
import type { CallPhase, CallResult, OnCallPhase } from "../x402/safePayer.js";
import { scheduler, type QueueInfo, type Slot } from "../x402/scheduler.js";
import { reputationFor } from "../registry/store.js";
import type { TaskPlan } from "./planner.js";

export interface Purchase {
  step: string;
  service: string;
  serviceId: string;
  category: Category;
  seller: string;
  why: string;
  status: CallResult["status"];
  listed: string;
  asked?: string;
  paid: string;
  txHash?: string;
  explorer?: string;
  reason?: string;
  latencyMs: number;
}

export interface QuoteLine {
  turn: number;
  as: string;
  service: string;
  category: Category;
  estimate: string;
  purpose?: string;
  input: unknown;
}

/** What a dry run would cost: the planned paid calls priced at each group's best-ranked seller. */
export interface Quote {
  lines: QuoteLine[];
  total: string;
  byCategory: Partial<Record<Category, string>>;
  note: string;
}

/** A paid call that is happening right now, for the live Run view. It leaves the list when its Purchase is recorded. */
export interface InflightCall {
  id: number;
  step: string;
  service: string;
  serviceId: string;
  phase: CallPhase;
  /** Amount the 402 asked for, once a quote has passed the checks. */
  asked?: string;
  /** Present while the call waits for a slot in the priority scheduler. */
  queue?: QueueInfo;
  startedAt: string;
  phaseAt: string;
}

export interface RunState {
  id: string;
  task: string;
  budget: string;
  maxConcurrency: number;
  state: "running" | "completed" | "partial" | "needs_more_budget" | "failed" | "interrupted";
  /** agent = the LLM plans in rounds; legacy = the built-in books pipeline (used as a fallback). */
  mode: "agent" | "legacy";
  dryRun: boolean;
  /** Wallet that pays for this run: the signed-in user's agent wallet, or the shared demo wallet. */
  buyer?: string;
  /** Signed-in user (lower-case wallet address) who started the run; absent for the shared demo wallet. */
  owner?: string;
  log: string[];
  plan?: TaskPlan;
  planner?: string;
  purchases: Purchase[];
  inflight?: InflightCall[];
  result?: any;
  quote?: Quote;
  explanation?: string;
  spent?: string;
  remaining?: string;
  startedAt: string;
  finishedAt?: string;
}

export type PayFn = (
  service: Service,
  input: Record<string, unknown>,
  ctx: { budget: BudgetLedger; runId?: string; onPhase?: OnCallPhase },
) => Promise<CallResult>;

export const usd = (u: bigint | string) => fromUnits(u);

export class Ctx {
  banned = new Set<string>();
  preferred = new Map<string, string>();
  /** Set when the wallet itself cannot pay any more (spend cap, rejected payment); later calls are skipped. */
  halted?: string;
  limit: ReturnType<typeof pLimit>;
  constructor(
    readonly run: RunState,
    readonly budget: BudgetLedger,
    maxConcurrency: number,
    readonly pay: PayFn,
  ) {
    this.limit = pLimit(Math.max(1, maxConcurrency));
  }
  log(msg: string) {
    this.run.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  }
  private calls = 0;
  /**
   * Pay one seller, listing the call in `run.inflight` with its live phase until it returns. Calls that contend for the
   * same wallet or seller wait in the priority scheduler first (see x402/scheduler.ts).
   */
  async payTracked(step: string, s: Service, input: Record<string, unknown>, opts: { retry?: boolean } = {}): Promise<CallResult> {
    const now = () => new Date().toISOString();
    const entry: InflightCall = { id: ++this.calls, step, service: s.name, serviceId: s.id, phase: "requesting", startedAt: now(), phaseAt: now() };
    const list = (this.run.inflight ??= []);
    list.push(entry);
    let slot: Slot | undefined;
    try {
      slot = await scheduler.acquire(
        {
          wallet: (this.run.buyer ?? "shared").toLowerCase(),
          sellerId: s.id,
          sellerName: s.name,
          runId: this.run.id,
          step,
          price: BigInt(s.price),
          budget: this.budget.budget,
          spent: this.budget.budget - this.budget.remaining,
          reputation: reputationFor(s.id).score,
          retry: opts.retry,
        },
        (q) => (entry.queue = q),
      );
      delete entry.queue;
      if (slot.beat.length || slot.forced) {
        this.log(`${step}: ${s.name} started ahead of ${slot.beat.length} waiting call(s), priority ${slot.priority.toFixed(2)}${slot.forced ? " (waited too long, started anyway)" : ""}`);
      }
      entry.startedAt = now();
      entry.phaseAt = now();
      return await this.pay(s, input, {
        budget: this.budget,
        runId: this.run.id,
        onPhase: (phase, asked) => {
          entry.phase = phase;
          entry.phaseAt = now();
          if (asked !== undefined) entry.asked = asked.toString();
        },
      });
    } finally {
      slot?.release();
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    }
  }
}

/** One line of the human-readable explanation for a purchase attempt. */
export function describePurchase(p: Purchase): string {
  const money =
    p.status === "paid" || p.status === "paid_output_rejected"
      ? `paid ${usd(p.paid)} USDC (tx ${p.txHash ?? "n/a"})`
      : p.status === "unconfirmed"
        ? `payment unconfirmed (up to ${usd(p.asked ?? p.listed)} USDC, counted against the budget until the chain settles it)`
        : "paid nothing";
  return `- ${p.step}: ${p.service} [${p.status}] ${money}. Why: ${p.why}.${p.reason ? ` Note: ${p.reason}.` : ""}`;
}

const why = (s: ServiceWithReputation, rank: number, total: number) =>
  `rank ${rank}/${total} in ${s.category}: reputation ${(s.reputation.score * 100).toFixed(0)}% (${s.reputation.successes}/${s.reputation.attempts} ok), price ${usd(s.price)} USDC, median latency ${s.reputation.medianLatencyMs ?? "n/a"} ms`;

export interface BuyOutcome {
  data?: any;
  budgetBlocked?: boolean;
  cheapest?: bigint;
  /** Why buying stopped without data, when it was not the seller's fault or the budget. */
  stop?: "spend_cap" | "payment_rejected" | "no_seller";
  /** Seller that delivered `data`. */
  service?: string;
  lastReason?: string;
}

/**
 * Buy one unit of work from a pool of interchangeable sellers: try them in reputation order, skipping any that already
 * misbehaved in this run. Price-check refusals, junk output and failures move on to the next seller; budget refusals stop.
 * `poolKey` scopes the "preferred seller" memory (a category for the legacy pipeline, a service group for the agent).
 */
export async function buyFrom(ctx: Ctx, poolKey: string, ranked: ServiceWithReputation[], step: string, input: Record<string, unknown>): Promise<BuyOutcome> {
  const pref = ctx.preferred.get(poolKey);
  const ordered = pref ? [...ranked].sort((a, b) => (a.id === pref ? -1 : b.id === pref ? 1 : 0)) : ranked;
  const candidates = ordered.filter((s) => !ctx.banned.has(s.id));
  if (!candidates.length) {
    ctx.log(`${step}: no usable ${poolKey} seller left`);
    return { stop: "no_seller" };
  }
  let budgetBlocked = false;
  let lastReason: string | undefined;
  for (const [i, s] of candidates.entries()) {
    if (budgetBlocked && BigInt(s.price) >= BigInt(candidates[i - 1].price)) continue;
    const reason = why(s, ranked.indexOf(s) + 1, ranked.length);
    let r = await ctx.limit(() => ctx.payTracked(step, s, input));
    if (r.reason?.startsWith("payment rejected: settlement failed")) {
      ctx.log(`${step}: ${s.name} settlement failed without charging; retrying once with a fresh signature`);
      await new Promise((res) => setTimeout(res, 1000));
      r = await ctx.limit(() => ctx.payTracked(step, s, input, { retry: true }));
    }
    ctx.run.purchases.push({
      step,
      service: s.name,
      serviceId: s.id,
      category: s.category,
      seller: s.payTo,
      why: reason,
      status: r.status,
      listed: s.price,
      asked: r.asked?.toString(),
      paid: r.paid.toString(),
      txHash: r.txHash,
      explorer: r.txHash ? EXPLORER_TX + r.txHash : undefined,
      reason: r.reason,
      latencyMs: r.latencyMs,
    });
    ctx.log(`${step}: ${s.name} -> ${r.status}${r.paid ? ` (${usd(r.paid)} USDC)` : ""}${r.reason ? ` - ${r.reason}` : ""}`);
    lastReason = r.reason ?? lastReason;
    if (r.ok) {
      ctx.preferred.set(poolKey, s.id);
      return { data: r.data, service: s.name };
    }
    if (r.reason?.startsWith("budget:")) {
      budgetBlocked = true;
      continue;
    }
    if (r.reason?.startsWith("spend cap:")) {
      ctx.log(`${step}: the buyer wallet's spend cap is reached; stopping purchases (${s.name} is not at fault)`);
      ctx.halted = r.reason;
      return { stop: "spend_cap", lastReason };
    }
    if (r.status === "unconfirmed") ctx.log(`${step}: ${s.name} payment outcome unknown; budget stays reserved until the chain confirms it`);
    if (r.reason?.startsWith("payment rejected:")) {
      ctx.log(`${step}: our payment was rejected (check the buyer's USDC balance); not blaming ${s.name}`);
      ctx.halted = r.reason;
      return { stop: "payment_rejected", lastReason };
    }
    ctx.banned.add(s.id);
    if (ctx.preferred.get(poolKey) === s.id) ctx.preferred.delete(poolKey);
  }
  const cheapest = candidates.reduce((m, s) => (BigInt(s.price) < m ? BigInt(s.price) : m), BigInt(candidates[0].price));
  return { budgetBlocked, cheapest, lastReason };
}
