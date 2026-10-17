import { config } from "../config.js";
import type { ChatMessage } from "../llm.js";
import type { ServiceWithReputation } from "../registry/store.js";
import { estimatePrice, groupServices, renderCatalogue, sampleFromSchema, type ServiceGroup } from "./catalogue.js";
import { parseRound, resolveCallInput, validateRound, type ResolvedCall, type Validated } from "./plan.js";
import { buyFrom, Ctx, describePurchase, usd, type Quote, type QuoteLine } from "./purchase.js";
import type { Store } from "./refs.js";
import { runTool } from "./tools.js";

export const MAX_TURNS = 6;
export const MAX_PAID_CALLS = 40;

export interface AgentDeps {
  /** Sends the conversation to the planner LLM and returns its raw reply (JSON text). */
  chat: (messages: ChatMessage[]) => Promise<string>;
  /** All registry services, best-ranked first. Called again whenever the agent needs fresh reputation. */
  services: () => ServiceWithReputation[];
}

/** handled: false means nothing was bought and the caller may fall back to the built-in pipeline. */
export type AgentOutcome = { handled: true } | { handled: false; reason: string };

const SYSTEM = (catalogue: string) => `You are Scout, a buyer agent. You finish the user's task by hiring paid services, using free local tools, and then giving a final answer. Every paid call spends real money from a fixed budget.

Reply with ONE JSON object per turn, with any of these keys:
{
  "calls": [ {"service": "<name from the catalogue>", "input": {...}, "as": "<result name>", "purpose": "<why, a few words>"} ],
  "tools": [ {"tool": "select" | "calc", "as": "<result name>", "args": {...}} ],
  "final": {"answer": "<plain-language answer>", "outputs": {"<label>": "$ref"}}
}

How a turn works:
- Within a turn, calls and tools may use each other's results: they run in dependency order (independent calls run in parallel). So plan everything you can in ONE turn, e.g. scrape, then select, then summarise the selected items. Use another turn only when you must see real results before you can decide what to do next.
- A reference is a string that is exactly $name plus an optional path: .field  [n]  [a:b] (slice)  [*]. A field after a list maps over its items. Examples: "$p1.books", "$top[0:2].description", "$fx.rate". Use references instead of copying data into your reply.
- Services marked interchangeable are the same job from several sellers: call the name once; the system chooses the seller and switches by itself if one fails.
- Pay only for what the task needs. Never repeat a call you already have a result for. When an input list allows several items (see "N-M items"), put as many items as allowed into one call: one batched call costs less than several.
- Do not sort, filter or calculate in your head. Tools:
  select: {"from": "$ref" or ["$ref1","$ref2"] (lists are joined), "compute": {"newField": "price_gbp * $fx.rate"}, "where": [{"field": "rating", "op": "eq|ne|gt|gte|lt|lte|contains|in", "value": 5}], "sort": {"by": "price_gbp", "order": "asc|desc"}, "limit": 3, "pick": ["title","url"]}  (applied in that order)
  calc: {"expr": "100 * $fx.rate"} (+ - * / ( ) round(x, digits))
- "final" must come alone, once you have everything you need. "outputs" holds the key results by reference (never retype data); "answer" is a short plain-language summary that uses only facts you have seen in the results. Write the answer as plain text: no markdown (no ** or #). Results are shortened for you (a "…" means the full text exists), so never retype or quote a shortened text in the answer; list full texts under "outputs" by reference and only mention them in the answer.
- Never refuse or shrink the task because the budget looks small. The system enforces the budget: it skips any call that does not fit and tells you. Start with the calls that matter most; if the budget or the wallet then cannot cover the rest, send "final" saying clearly what is missing, using whatever you have.
- You have at most ${MAX_TURNS} turns. Names for results must be new each time.

Service catalogue (price is per call, in USDC):
${catalogue}`;

// ---- showing results to the model -----------------------------------------------------------------------------------

function shrink(v: unknown): unknown {
  if (typeof v === "string") return v.length > 160 ? `${v.slice(0, 160)}…(${v.length} chars)` : v;
  if (Array.isArray(v)) return v.length > 5 ? [...v.slice(0, 5).map(shrink), `…(+${v.length - 5} more items)`] : v.map(shrink);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
  return v;
}

export function preview(v: unknown, max = 1800): string {
  const text = JSON.stringify(shrink(v)) ?? "null";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

export async function runAgent(ctx: Ctx, deps: AgentDeps): Promise<AgentOutcome> {
  const { run } = ctx;
  const dry = run.dryRun;
  const all = deps.services();
  const groups = groupServices(all);
  if (!groups.length) return { handled: false, reason: "the registry lists no services" };
  const budget = BigInt(run.budget);

  run.planner = `agent (${config.ollama.model})`;
  const store: Store = new Map();
  const failures = new Map<string, string>();
  const quote: (QuoteLine & { skipped?: boolean })[] = [];
  let estSpent = 0n; // dry run only
  let skippedNeed = 0n;
  let blocked = false;
  let callsUsed = 0;
  let final: { answer: string; outputs: Record<string, unknown> } | undefined;
  let endedEarly: string | undefined;

  const membersOf = (g: ServiceGroup) => deps.services().filter((s) => g.memberIds.includes(s.id));

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM(renderCatalogue(groups)) },
    {
      role: "user",
      content:
        `Task: ${run.task}\nBudget: ${usd(run.budget)} USDC.\nTurn 1 of ${MAX_TURNS}.` +
        (dry ? "\nThis is a DRY RUN: paid calls return made-up sample data and cost nothing. Plan exactly as you would for real; do not mention the sample data." : ""),
    },
  ];
  ctx.log(`agent: ${groups.length} service group(s) in the catalogue (${groups.map((g) => g.handle + (g.memberIds.length > 1 ? `×${g.memberIds.length}` : "")).join(", ")})`);

  /** Ask the model for one turn; if the reply is unusable, show it what is wrong and ask once more. */
  async function askTurn(turn: number): Promise<{ ok: true; v: Validated } | { ok: false; reason: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: string | undefined;
      let lastError: any;
      // gpt-oss sometimes returns an empty message or stalls once; one more try is cheap and nothing has been paid yet.
      for (let tries = 0; tries < 2 && raw === undefined; tries++) {
        try {
          raw = await deps.chat(messages);
        } catch (err: any) {
          lastError = err;
          if (tries === 0) ctx.log(`turn ${turn}: the planner LLM did not answer (${err?.message ?? err}); trying once more`);
        }
      }
      if (raw === undefined) return { ok: false, reason: `the planner LLM is unavailable (${lastError?.message ?? lastError})` };
      messages.push({ role: "assistant", content: raw });
      const parsed = parseRound(raw, store.keys());
      const v = parsed.ok ? validateRound(parsed.round, { groups, all: deps.services(), store, callsLeft: MAX_PAID_CALLS - callsUsed, started: callsUsed > 0 || store.size > 0 }) : undefined;
      const issues = parsed.ok ? v!.issues : [parsed.error];
      if (!issues.length) return { ok: true, v: v! };
      ctx.log(`turn ${turn}: the plan has ${issues.length} problem(s): ${issues.join(" | ")}`);
      if (attempt === 1) return { ok: false, reason: `the plan was still invalid after one repair: ${issues.join("; ")}` };
      messages.push({
        role: "user",
        content: `Your reply could not be used. Nothing has been paid for yet.\n${issues.map((i) => `- ${i}`).join("\n")}\nReply again with ONE corrected JSON object for this same turn.`,
      });
      ctx.log(`turn ${turn}: asking the planner to repair its plan`);
    }
    return { ok: false, reason: "no usable plan" };
  }

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const asked = await askTurn(turn);
    if (!asked.ok) {
      if (run.purchases.length === 0) return { handled: false, reason: asked.reason };
      endedEarly = `Stopped after ${run.purchases.length} purchase attempt(s): ${asked.reason}`;
      ctx.log(`stopped: ${endedEarly}`);
      break;
    }
    const v = asked.v;
    if (v.finalIgnored) ctx.log(`turn ${turn}: a final answer arrived together with new calls; ignoring it until the results are in`);
    if (v.final) {
      final = v.final;
      ctx.log(`turn ${turn}: final answer received`);
      break;
    }

    const report: string[] = [];
    callsUsed += v.calls.length;

    // Run in dependency order: each wave holds the steps whose inputs already exist (calls first, then tools).
    const unavailable = (names: string[]) => names.find((n) => !store.has(n));
    let pendingCalls = [...v.calls];
    let pendingTools = [...v.tools];
    while (pendingCalls.length || pendingTools.length) {
      const isReady = (deps: string[]) => deps.every((d) => store.has(d) || failures.has(d));
      const readyCalls = pendingCalls.filter((c) => isReady(c.deps));
      const readyTools = pendingTools.filter((t) => isReady(t.deps));
      if (!readyCalls.length && !readyTools.length) break; // cannot happen after validation; guards against a loop
      pendingCalls = pendingCalls.filter((c) => !readyCalls.includes(c));
      pendingTools = pendingTools.filter((t) => !readyTools.includes(t));

      // ---- paid calls ------------------------------------------------------------------------------------------------
      const runnable: ResolvedCall[] = [];
      for (const call of readyCalls) {
        const missing = unavailable(call.deps);
        if (missing) {
          failures.set(call.as, `skipped: it needs $${missing}, which is not available`);
          continue;
        }
        const input = call.input ?? resolveCallInput(call, store);
        if (typeof input === "string") {
          failures.set(call.as, `skipped, nothing paid: ${input}`);
          continue;
        }
        runnable.push({ ...call, input });
      }

      let available = dry ? budget - estSpent : ctx.budget.remaining;
      const admitted: ResolvedCall[] = [];
      for (const call of runnable) {
        const usable = membersOf(call.group).filter((m) => !ctx.banned.has(m.id));
        const est = estimatePrice(usable);
        const line: QuoteLine & { skipped?: boolean } = { turn, as: call.as, service: call.group.handle, category: call.group.category, estimate: est.toString(), purpose: call.purpose, input: call.input };
        if (ctx.halted) {
          failures.set(call.as, `skipped: ${ctx.halted}`);
          continue;
        }
        if (!usable.length) {
          failures.set(call.as, "skipped: every seller in this group already failed during this run");
          continue;
        }
        if (est > available) {
          blocked = true;
          skippedNeed += est;
          failures.set(call.as, `skipped: needs about ${usd(est)} USDC but only ${usd(available)} is left in the budget`);
          if (dry) quote.push({ ...line, skipped: true });
          continue;
        }
        available -= est;
        admitted.push(call);
        if (dry) {
          quote.push(line);
          estSpent += est;
          store.set(call.as, sampleFromSchema(call.group.outputSchema));
        }
      }

      if (!dry && admitted.length) {
        const paidFor = (step: string) => run.purchases.filter((p) => p.step === step && p.status === "paid").at(-1);
        const runCall = async (call: ResolvedCall) => {
          const step = call.purpose ? `${call.as}: ${call.purpose.slice(0, 60)}` : call.as;
          const out = await buyFrom(ctx, call.group.key, membersOf(call.group), step, call.input!);
          if (out.data !== undefined) {
            store.set(call.as, out.data);
            report.push(`$${call.as} <- ${out.service}, paid ${usd(paidFor(step)?.paid ?? "0")} USDC: ${preview(out.data)}`);
            return;
          }
          if (out.budgetBlocked) {
            blocked = true;
            skippedNeed += out.cheapest ?? 0n;
            failures.set(call.as, "budget: the remaining budget did not cover this call");
          } else if (out.stop === "spend_cap" || out.stop === "payment_rejected") failures.set(call.as, `wallet: ${out.lastReason ?? out.stop}`);
          else failures.set(call.as, `no seller delivered a valid result${out.lastReason ? ` (last problem: ${out.lastReason})` : ""}`);
        };
        // Probe each group with one call first so a bad seller is discovered once, then fan out the rest in parallel.
        const byGroup = new Map<string, ResolvedCall[]>();
        for (const c of admitted) byGroup.set(c.group.key, [...(byGroup.get(c.group.key) ?? []), c]);
        await Promise.all(
          [...byGroup.values()].map(async ([first, ...rest]) => {
            await runCall(first);
            await Promise.all(rest.map(runCall));
          }),
        );
      }
      for (const call of readyCalls) {
        if (failures.has(call.as)) report.push(`$${call.as}: NOT AVAILABLE - ${failures.get(call.as)}`);
        else if (dry) report.push(`$${call.as} <- ${call.group.handle} (sample): ${preview(store.get(call.as))}`);
      }

      // ---- free local tools ------------------------------------------------------------------------------------------
      for (const t of readyTools) {
        const missing = unavailable(t.deps);
        try {
          if (missing) throw new Error(`it needs $${missing}, which is not available`);
          const value = runTool(t.tool, t.args, store);
          store.set(t.as, value);
          report.push(`$${t.as} (${t.tool}): ${preview(value)}`);
          ctx.log(`turn ${turn}: tool ${t.tool} -> $${t.as}`);
        } catch (err: any) {
          failures.set(t.as, `tool ${t.tool} failed: ${err?.message ?? err}`);
          report.push(`$${t.as}: NOT AVAILABLE - tool ${t.tool} failed: ${err?.message ?? err}`);
          ctx.log(`turn ${turn}: tool ${t.tool} failed: ${err?.message ?? err}`);
        }
      }
    }

    const left = dry ? budget - estSpent : ctx.budget.remaining;
    const next = turn + 1;
    messages.push({
      role: "user",
      content:
        `Results of turn ${turn}:\n${report.join("\n") || "(nothing)"}\n\nBudget left: ${usd(left)} USDC. Paid calls left: ${MAX_PAID_CALLS - callsUsed}.` +
        (ctx.halted ? `\nThe wallet cannot pay any more (${ctx.halted}). Send "final" now.` : blocked ? `\nThe budget did not cover some calls. If the rest cannot be finished, send "final" explaining what is missing.` : "") +
        (next > MAX_TURNS ? "" : next === MAX_TURNS ? `\nTurn ${next} of ${MAX_TURNS} is your LAST: send "final" now.` : `\nTurn ${next} of ${MAX_TURNS}.`),
    });
  }

  // ---- outcome ----------------------------------------------------------------------------------------------------
  const paidCalls = run.purchases.filter((p) => p.status === "paid" || p.status === "paid_output_rejected");
  const total = sum(quote.map((q) => BigInt(q.estimate)));
  if (dry) {
    const byCategory: Quote["byCategory"] = {};
    for (const q of quote) byCategory[q.category] = (BigInt(byCategory[q.category] ?? "0") + BigInt(q.estimate)).toString();
    run.quote = {
      lines: quote,
      total: total.toString(),
      byCategory,
      note: "Estimates use the dearest seller in each group that has not proved unreliable, so a cheaper seller that behaves can only lower the bill. Reputation can change which seller is chosen.",
    };
    run.spent = "0";
    run.remaining = run.budget;
    if (total > budget) blocked = true;
  } else {
    run.spent = ctx.budget.spent.toString();
    run.remaining = (ctx.budget.budget - ctx.budget.spent).toString();
  }

  const nonBudgetFailures = [...failures].filter(([, why]) => !why.startsWith("skipped: needs") && !why.startsWith("budget:"));
  if (ctx.halted) run.state = paidCalls.length ? "partial" : "failed";
  else if (blocked) run.state = "needs_more_budget";
  else if (!final) run.state = store.size || paidCalls.length ? "partial" : "failed";
  else run.state = nonBudgetFailures.length ? "partial" : "completed";

  if (blocked) {
    const need = dry ? total - budget : skippedNeed - (ctx.budget.budget - ctx.budget.spent);
    const shown = need > 0n ? need : skippedNeed;
    ctx.log(
      dry
        ? `stopped: the planned calls would cost about ${usd(total)} USDC but the budget is ${usd(run.budget)}. Need about ${usd(shown)} USDC more.`
        : `stopped: budget exhausted. Spent ${usd(run.spent)} of ${usd(run.budget)} USDC. Need about ${usd(shown)} USDC more to finish.`,
    );
  }

  const answer = dry
    ? `Dry run: nothing was bought. The agent planned ${quote.filter((q) => !q.skipped).length + quote.filter((q) => q.skipped).length} paid call(s) costing about ${usd(total)} USDC against a budget of ${usd(run.budget)} USDC.`
    : (final?.answer ?? endedEarly ?? `The agent used all ${MAX_TURNS} turns without giving a final answer.`);
  run.result = { answer, outputs: dry ? {} : (final?.outputs ?? {}), turns: Math.min(messages.filter((m) => m.role === "assistant").length, MAX_TURNS), ...(dry ? { dryRun: true } : {}) };
  run.explanation = explain(run, answer, failures, quote, dry);
  return { handled: true };
}

function explain(run: Ctx["run"], answer: string, failures: Map<string, string>, quote: (QuoteLine & { skipped?: boolean })[], dry: boolean): string {
  const lines = [`Task: ${run.task}`];
  if (dry) {
    lines.push(`Outcome: ${run.state}. Dry run, nothing was paid. Budget ${usd(run.budget)} USDC.`);
    for (const q of quote) lines.push(`- turn ${q.turn}, ${q.as}: ${q.service} [${q.category}] about ${usd(q.estimate)} USDC${q.skipped ? " (would not fit the budget)" : ""}${q.purpose ? `. ${q.purpose}` : ""}`);
  } else {
    const paid = run.purchases.filter((p) => p.status === "paid" || p.status === "paid_output_rejected");
    lines.push(`Outcome: ${run.state}. Spent ${usd(run.spent ?? "0")} of ${usd(run.budget)} USDC across ${paid.length} paid call(s); ${usd(run.remaining ?? run.budget)} USDC left.`);
    for (const p of run.purchases) lines.push(describePurchase(p));
  }
  for (const [name, why] of failures) lines.push(`- Not obtained: ${name} (${why})`);
  lines.push(`Answer: ${answer}`);
  return lines.join("\n");
}
