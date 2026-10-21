"use client";

import { AnimatePresence, motion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Counter } from "@/components/landing/counter";
import { elapsed, useNow } from "@/lib/clock";
import { usdc } from "@/lib/format";
import { spring, transition } from "@/lib/motion";
import type { Run, RunStateName } from "@/lib/types";

const STATE_TONE: Record<RunStateName, string> = {
  running: "border-info/40 bg-info/10 text-info",
  completed: "border-ok/40 bg-ok/10 text-ok",
  partial: "border-warn/40 bg-warn/10 text-warn",
  needs_more_budget: "border-warn/40 bg-warn/10 text-warn",
  failed: "border-bad/40 bg-bad/10 text-bad",
  interrupted: "border-warn/40 bg-warn/10 text-warn",
};

const DONE_TEXT: Record<Exclude<RunStateName, "running">, string> = {
  completed: "Done.",
  partial: "Finished, with some gaps.",
  needs_more_budget: "Stopped: the budget ran out.",
  failed: "The run failed.",
  interrupted: "Stopped: the server restarted.",
};

/** One sentence for what the agent is doing right now. */
function activity(run: Run): string {
  if (run.state !== "running") return DONE_TEXT[run.state];
  const n = run.inflight?.length ?? 0;
  if (n) return `Paying ${n} seller${n > 1 ? "s" : ""}`;
  if (!run.log.length) return "Starting the agent";
  if (!run.purchases.length) return run.dryRun ? "Pricing the plan" : "Planning the work";
  return "Reading results, planning the next calls";
}

/** Money actually paid so far. The server only sets `spent` when the run ends. */
function spentUnits(run: Run): number {
  if (run.spent !== undefined) return Number(run.spent);
  return run.purchases.reduce((sum, p) => sum + Number(p.paid || 0), 0);
}

export function RunStatus({ run }: { run: Run }) {
  const now = useNow(1000);
  const running = run.state === "running";
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const took = now || run.finishedAt ? end - Date.parse(run.startedAt) : 0;
  const budget = Number(run.budget);
  const spent = spentUnits(run);
  const share = budget > 0 ? Math.min(1, spent / budget) : 0;
  const text = activity(run);
  const hint = [run.dryRun ? "dry run" : "", run.mode === "legacy" ? "built-in books pipeline" : (run.planner ?? "")]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[11px] text-muted-foreground">
            run {run.id}
            {hint ? ` · ${hint}` : ""}
          </div>
          {/* The dots sit outside the swapping sentence: their endless loop
              would otherwise hold up its exit, and the old text with it. */}
          <div className="mt-2 flex min-h-10 items-baseline font-display text-3xl sm:text-4xl">
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={text}
                aria-live="polite"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={transition.base}
              >
                {text}
              </motion.p>
            </AnimatePresence>
            {running ? <Ellipsis /> : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <Badge variant="outline" className={"font-mono " + STATE_TONE[run.state]}>
            {run.state.replace(/_/g, " ")}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {took ? elapsed(took) : "…"}
          </span>
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 font-mono text-xs">
          <span className="text-muted-foreground">
            spent{" "}
            <span className="text-base text-primary">
              <Counter value={spent / 1e6} decimals={4} duration={0.8} />
            </span>{" "}
            of {usdc(run.budget)} USDC
          </span>
          <span className="text-muted-foreground">
            {usdc(run.remaining ?? String(Math.max(0, budget - spent)))} left · {run.purchases.length} call
            {run.purchases.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted dark:bg-foreground/12">
          <motion.div
            className="h-full origin-left rounded-full bg-primary"
            initial={false}
            animate={{ scaleX: share }}
            transition={spring.number}
          />
        </div>
      </div>
    </section>
  );
}

/** Three dots that breathe while the run is live (static for reduced motion). */
function Ellipsis() {
  return (
    <span aria-hidden className="ml-0.5 inline-flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
        >
          .
        </motion.span>
      ))}
    </span>
  );
}
