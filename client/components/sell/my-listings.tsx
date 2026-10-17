"use client";

import { useState } from "react";
import { ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/status-badge";
import { usdc } from "@/lib/format";
import { deleteListing } from "@/lib/api";
import type { AgentInfo, ChainInfo, Service } from "@/lib/types";

export function MyListings({
  services,
  agents,
  chains,
  onEdit,
  onChanged,
}: {
  services: Service[];
  agents: Record<string, AgentInfo>;
  chains: Record<string, ChainInfo>;
  onEdit: (s: Service) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(s: Service) {
    if (!window.confirm(`Delete "${s.name}" from the marketplace?`)) return;
    setBusy(s.id);
    setError(null);
    try {
      await deleteListing(s.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete.");
    } finally {
      setBusy(null);
    }
  }

  if (!services.length) return <p className="text-sm text-muted-foreground">You have not listed anything yet.</p>;

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p> : null}
      {services.map((s) => (
        <div key={s.id} className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium">{s.name}</span>
            <CategoryBadge category={s.category} />
            {agents[s.id] ? (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">LLM agent · {agents[s.id].model}</span>
            ) : null}
            {chains[s.id] ? (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">agent chain · {chains[s.id].hires.join(" → ")}</span>
            ) : null}
            <span className="font-mono text-sm text-primary">{usdc(s.price)} USDC / call</span>
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="outline" onClick={() => onEdit(s)} disabled={busy === s.id}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" className="text-bad" onClick={() => remove(s)} disabled={busy === s.id}>
                Delete
              </Button>
            </span>
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {s.method} {s.endpoint}
          </div>
          {s.verification === "mismatch" ? (
            <div className="flex items-start gap-1.5 rounded-md border border-bad/30 bg-bad/10 px-2 py-1 text-[11px] text-bad">
              <ShieldAlertIcon className="mt-0.5 size-3 shrink-0" />
              <span>402 does not match this listing — {s.verificationNote.replace(/^402 contradicts the listing: /, "")}. Buyers will try you last.</span>
            </div>
          ) : s.verification === "verified" ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={s.verificationNote}>
              <ShieldCheckIcon className="size-3 text-primary" />
              402 checked against the listing
            </div>
          ) : (
            <div className="text-[11px] text-warn">Could not check the endpoint{s.verificationNote ? `: ${s.verificationNote}` : "."} Save again to re-check.</div>
          )}
          <div className="text-[11px] text-muted-foreground">
            {s.reputation.attempts ? `${s.reputation.successes}/${s.reputation.attempts} calls succeeded` : "no calls yet"}
          </div>
        </div>
      ))}
    </div>
  );
}
