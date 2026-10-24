"use client";

import { Fragment, useState } from "react";
import { ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/status-badge";
import { usdc } from "@/lib/format";
import { deleteListing, deleteMcpServer } from "@/lib/api";
import type { AgentInfo, ChainInfo, ChainStats, McpInfo, Service } from "@/lib/types";

/** What a chain has earned, spent and kept; failed and test runs cost money too, so they are in the cost. */
function ChainStatsLine({ stats }: { stats: ChainStats }) {
  const lost = stats.profit.startsWith("-");
  const last = stats.recent.find((r) => r.kind === "sale" && r.outcome === "failed");
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono">
        <span>{stats.calls} paid {stats.calls === 1 ? "call" : "calls"}</span>
        <span>{stats.failures} failed</span>
        <span>earned {usdc(stats.revenue)}</span>
        <span>spent on sellers {usdc(stats.cost)}</span>
        <span className={lost ? "text-bad" : "text-primary"}>{lost ? "lost" : "kept"} {usdc(stats.profit.replace("-", ""))} USDC</span>
      </div>
      {last?.error ? <div className="truncate text-muted-foreground" title={last.error}>last failure: {last.error}</div> : null}
    </div>
  );
}

export function MyListings({
  services,
  agents,
  chains,
  mcp,
  onRefreshMcp,
  onEdit,
  onChanged,
}: {
  services: Service[];
  agents: Record<string, AgentInfo>;
  chains: Record<string, ChainInfo>;
  mcp: Record<string, McpInfo>;
  onRefreshMcp: (info: McpInfo, s: Service) => void;
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

  async function removeServer(serverId: string, tools: number) {
    if (!window.confirm(`Delete all ${tools} ${tools === 1 ? "tool" : "tools"} of "${serverId}" from the marketplace? Its saved token goes too.`)) return;
    setBusy(`mcp:${serverId}`);
    setError(null);
    try {
      await deleteMcpServer(serverId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete.");
    } finally {
      setBusy(null);
    }
  }

  if (!services.length) return <p className="text-sm text-muted-foreground">You have not listed anything yet.</p>;

  // The tools of one MCP server sit together under one header, placed where the first of them was.
  const servers = new Map<string, Service[]>();
  for (const s of services) {
    const id = mcp[s.id]?.serverId;
    if (id) servers.set(id, [...(servers.get(id) ?? []), s]);
  }
  const ordered = services.flatMap((s) => {
    const group = servers.get(mcp[s.id]?.serverId);
    return !group ? [s] : group[0] === s ? group : [];
  });

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p> : null}
      {ordered.map((s) => {
        const server = mcp[s.id]?.serverId;
        const tools = server ? servers.get(server)! : [];
        return (
          <Fragment key={s.id}>
            {tools[0] === s ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                  MCP server · {server} · {tools.length} {tools.length === 1 ? "tool" : "tools"}
                </span>
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => onRefreshMcp(mcp[s.id], s)} disabled={busy === `mcp:${server}`} title="Change which tools are on sale and their prices">
                    Refresh server
                  </Button>
                  <Button size="sm" variant="ghost" className="text-bad" onClick={() => removeServer(server!, tools.length)} disabled={busy === `mcp:${server}`}>
                    Delete server
                  </Button>
                </span>
              </div>
            ) : null}
            <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium">{s.name}</span>
                <CategoryBadge category={s.category} />
                {agents[s.id] ? (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">LLM agent · {agents[s.id].model}</span>
                ) : null}
                {mcp[s.id] ? (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">MCP tool · {mcp[s.id].serverId}</span>
                ) : null}
                {s.access === "write" ? <span className="rounded bg-warn/15 px-1.5 py-0.5 font-mono text-[10px] text-warn">changes data</span> : null}
                {chains[s.id] ? (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">agent chain · {chains[s.id].hires.join(" → ")}</span>
                ) : null}
                <span className="font-mono text-sm text-primary">{usdc(s.price)} USDC / call</span>
                <span className="ml-auto flex gap-1">
                  {mcp[s.id] ? null : (
                    <Button size="sm" variant="outline" onClick={() => onEdit(s)} disabled={busy === s.id}>
                      Edit
                    </Button>
                  )}
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
              {chains[s.id]?.stats ? <ChainStatsLine stats={chains[s.id].stats} /> : null}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
