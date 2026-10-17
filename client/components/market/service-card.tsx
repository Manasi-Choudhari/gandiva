"use client";

import type { Ref } from "react";
import { motion } from "motion/react";
import { LinkIcon, ScaleIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CredibilityBadge } from "./credibility-badge";
import { CategoryBadge } from "@/components/status-badge";
import { AddrLink } from "@/components/tx-link";
import { ADVERSARIAL_IDS, pct, usdc } from "@/lib/format";
import type { Service } from "@/lib/types";
import { spring, transition } from "@/lib/motion";
import { cn } from "cn";

/**
 * The card's border draws itself on hover: top, right, bottom, left in turn.
 * Transform only, so it stays cheap on weak GPUs; it all retracts at once.
 */
function EdgeDraw({ tone }: { tone: string }) {
  const edge = cn(
    "absolute transition-transform duration-200 ease-out-quint motion-reduce:transition-none",
    tone,
  );
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 z-10">
      <span className={cn(edge, "top-0 right-3 left-3 h-0.5 origin-left scale-x-0 group-hover:scale-x-100")} />
      <span className={cn(edge, "top-3 right-0 bottom-3 w-0.5 origin-top scale-y-0 group-hover:scale-y-100 group-hover:delay-150")} />
      <span className={cn(edge, "right-3 bottom-0 left-3 h-0.5 origin-right scale-x-0 group-hover:scale-x-100 group-hover:delay-300")} />
      <span className={cn(edge, "top-3 bottom-3 left-0 w-0.5 origin-bottom scale-y-0 group-hover:scale-y-100 group-hover:delay-450")} />
    </span>
  );
}

export function ServiceCard({
  service,
  index,
  ref,
  onCompare,
  comparing,
}: {
  service: Service;
  index: number;
  ref?: Ref<HTMLDivElement>;
  onCompare?: () => void;
  comparing?: boolean;
}) {
  const adversarial = ADVERSARIAL_IDS.has(service.id);
  const rep = service.reputation;

  return (
    <motion.div
      ref={ref}
      id={`svc-${service.id}`}
      tabIndex={-1}
      layout="position"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, transition: transition.base }}
      transition={{ ...transition.base, delay: Math.min(index * 0.04, 0.32), layout: spring.soft }}
      whileHover={{ y: -4, transition: spring.soft }}
      className="group relative h-full min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
    >
      <EdgeDraw tone={adversarial ? "bg-bad/70" : "bg-primary"} />
      {/* Search lands here: the page restarts a brief wash on this layer. */}
      <span data-flash aria-hidden className="pointer-events-none absolute inset-0 z-10 rounded-xl" />
      <Card
        className={
          "h-full ring-1 transition-colors " +
          (adversarial
            ? "ring-bad/30 hover:ring-bad/50"
            : "ring-foreground/10 hover:ring-primary/40")
        }
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div className="font-mono text-sm font-medium">{service.name}</div>
            <CategoryBadge category={service.category} />
          </div>
          <div className="text-xs text-muted-foreground">
            {service.description || "No description."}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-2xl text-primary">
              {usdc(service.price)}
            </span>
            <span className="text-xs text-muted-foreground">USDC / call</span>
            {service.credibility ? (
              <CredibilityBadge score={service.credibility.score} level={service.credibility.level} className="ml-auto self-center" />
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                reputation
                {rep.isNew ? (
                  <span className="rounded bg-primary/15 px-1 font-mono text-[10px] uppercase text-primary">
                    new
                  </span>
                ) : null}
              </span>
              <span className="font-mono">
                {rep.attempts
                  ? `${pct(rep.successRate)} success · ${rep.successes}/${rep.attempts}`
                  : "no calls yet"}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted dark:bg-foreground/12">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.round(rep.score * 100)}%` }}
              />
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
            <dt>method</dt>
            <dd className="text-foreground">{service.method}</dd>
            <dt>latency</dt>
            <dd className="text-foreground">
              {rep.medianLatencyMs ? `${rep.medianLatencyMs} ms` : "n/a"}
            </dd>
            <dt>payTo</dt>
            <dd className="text-foreground">
              <AddrLink address={service.payTo} />
            </dd>
            <dt>owner</dt>
            <dd className="text-foreground">{service.owner}</dd>
            <dt>network</dt>
            <dd className="text-foreground">{service.network}</dd>
          </dl>

          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {service.endpoint}
          </div>

          {service.verification === "mismatch" ? (
            <div className="flex items-start gap-1.5 rounded-md border border-bad/30 bg-bad/10 px-2 py-1 text-[11px] text-bad">
              <ShieldAlertIcon className="mt-0.5 size-3 shrink-0" />
              <span>402 does not match this listing — {service.verificationNote.replace(/^402 contradicts the listing: /, "")}</span>
            </div>
          ) : service.verification === "verified" ? (
            <div
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              title={service.verificationNote}
            >
              <ShieldCheckIcon className="size-3 text-primary" />
              402 checked against the listing
            </div>
          ) : null}

          {service.chain ? (
            <div className="flex items-start gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] text-primary">
              <LinkIcon className="mt-0.5 size-3 shrink-0" />
              <span>agent chain — hires {service.chain.hires.length ? service.chain.hires.join(", ") : "other sellers"} and pays them from its own wallet to do the job</span>
            </div>
          ) : null}

          {adversarial ? (
            <div className="flex items-center gap-1.5 rounded-md border border-bad/30 bg-bad/10 px-2 py-1 text-[11px] text-bad">
              <ShieldAlertIcon className="size-3" />
              deliberately hostile seller — the buyer should route around it
            </div>
          ) : null}

          {onCompare ? (
            <Button variant={comparing ? "default" : "outline"} size="sm" className="mt-auto" onClick={onCompare}>
              <ScaleIcon /> {comparing ? "Comparing" : `Compare with other ${service.category} sellers`}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </motion.div>
  );
}
