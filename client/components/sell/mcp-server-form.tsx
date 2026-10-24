"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loadMcpTools, saveMcpServer } from "@/lib/api";
import { toUnits, usdc } from "@/lib/format";
import type { Category, McpInfo, McpSaved, McpTool, McpToolsLoaded } from "@/lib/types";
import { priceProblem } from "./listing-preview";

const FIELD =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

const DEFAULT_URL = "https://huggingface.co/mcp";
const CATEGORIES: Category[] = ["data", "inference", "scraping"];
const MAX_TOOLS = 20;

type Pick = { on: boolean; price: string };

const ACCESS_LABEL: Record<McpTool["access"], string> = { read: "read only", write: "changes data", unknown: "not declared" };

/**
 * First ticks for a freshly read server. A tool already on sale keeps its price. Anything else starts unticked when
 * the server is already listed, or when it changes data, so nothing goes on sale without the seller choosing it.
 */
function firstPicks(tools: McpTool[], defaultPrice: string): Record<string, Pick> {
  const relisting = tools.some((t) => t.listedPrice);
  let ticked = 0;
  return Object.fromEntries(
    tools.map((t) => {
      const on = t.usable && (relisting ? Boolean(t.listedPrice) : t.access !== "write" && ticked < MAX_TOOLS);
      if (on) ticked++;
      return [t.name, { on, price: t.listedPrice ? usdc(t.listedPrice) : defaultPrice }];
    }),
  );
}

/**
 * Sell-tab "MCP server" template: give an MCP server's URL (and bearer token), pick its tools and price each one.
 * Every picked tool is listed as its own paid tool that pays your wallet.
 * `refresh` re-reads a server that is already listed, to change its picks and prices.
 */
export function McpServerForm({
  refresh,
  onSaved,
  onCancel,
}: {
  refresh: (McpInfo & { price: string; category: Category }) | null;
  onSaved: (saved: McpSaved) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(refresh?.url ?? DEFAULT_URL);
  const [token, setToken] = useState("");
  const [name, setName] = useState(refresh?.serverId ?? "");
  const [priceUsdc, setPriceUsdc] = useState(refresh ? usdc(refresh.price) : "0.002");
  const [category, setCategory] = useState<Category>(refresh?.category ?? "data");
  const [loaded, setLoaded] = useState<McpToolsLoaded | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenSaved = Boolean((refresh && refresh.hasToken && url.trim() === refresh.url) || loaded?.hasToken);

  // A different URL or token means the tools shown are no longer the ones that would be listed.
  const edit = (patch: { url?: string; token?: string }) => {
    if (patch.url !== undefined) setUrl(patch.url);
    if (patch.token !== undefined) setToken(patch.token);
    setLoaded(null);
  };

  const pickFor = (tool: string): Pick => picks[tool] ?? { on: false, price: priceUsdc };
  const setPick = (tool: string, patch: Partial<Pick>) => setPicks((all) => ({ ...all, [tool]: { ...pickFor(tool), ...patch } }));
  const applyPrice = () => setPicks((all) => Object.fromEntries(Object.entries(all).map(([tool, p]) => [tool, p.on ? { ...p, price: priceUsdc } : p])));

  async function load() {
    setLoading(true);
    setError(null);
    setLoaded(null);
    try {
      const out = await loadMcpTools({ url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}), ...(refresh ? { serverId: refresh.serverId } : {}) });
      setPicks(firstPicks(out.tools, priceUsdc));
      setLoaded(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that server.");
    } finally {
      setLoading(false);
    }
  }

  const picked = loaded?.tools.filter((t) => t.usable && pickFor(t.name).on) ?? [];
  const leaving = loaded?.tools.filter((t) => t.listedPrice && !pickFor(t.name).on) ?? [];
  const tooMany = picked.length > MAX_TOOLS;

  async function submit() {
    setError(null);
    for (const t of picked) {
      const problem = priceProblem(pickFor(t.name).price);
      if (problem) return setError(`${t.name}: ${problem}`);
    }
    setSaving(true);
    try {
      const saved = await saveMcpServer({
        url: url.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(refresh ? { changeUrl: true } : {}),
        category,
        tools: picked.map((t) => ({ name: t.name, price: toUnits(pickFor(t.name).price)! })),
      });
      setToken("");
      setLoaded(null);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not list the tools.");
    } finally {
      setSaving(false);
    }
  }

  const ready = Boolean(loaded) && picked.length > 0 && !tooMany;

  return (
    <form
      noValidate
      className="flex max-w-3xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!saving && ready) void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Give us an MCP server (Streamable HTTP, public https), then pick which tools to sell and price each one. A buyer pays your wallet in USDC, we call the tool on your server with your token, and return its answer. If the tool
        fails or returns nothing, the buyer is not charged.
      </p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="m-url" className="text-xs text-muted-foreground">
          MCP server URL
        </Label>
        <Input id="m-url" className="font-mono" value={url} onChange={(e) => edit({ url: e.target.value })} placeholder={DEFAULT_URL} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="m-token" className="text-xs text-muted-foreground">
          Bearer token (optional; stored encrypted, never shown again)
        </Label>
        <Input
          id="m-token"
          type="password"
          autoComplete="off"
          className="font-mono"
          value={token}
          onChange={(e) => edit({ token: e.target.value })}
          placeholder={tokenSaved ? "saved, leave blank to keep" : "leave blank if the server is open"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="m-price" className="text-xs text-muted-foreground">
            Price per call (USDC)
          </Label>
          <div className="flex gap-2">
            <Input id="m-price" inputMode="decimal" className="min-w-0 font-mono" value={priceUsdc} onChange={(e) => setPriceUsdc(e.target.value)} />
            {loaded ? (
              <Button type="button" variant="outline" size="sm" className="h-auto shrink-0" onClick={applyPrice}>
                Set all
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="m-category" className="text-xs text-muted-foreground">
            Category
          </Label>
          <select id="m-category" className={FIELD} value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="m-name" className="text-xs text-muted-foreground">
            Group name (optional)
          </Label>
          <Input id="m-name" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={loaded?.name ?? "from the URL"} disabled={Boolean(refresh)} maxLength={40} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={load} disabled={loading || saving || !url.trim()}>
          {loading ? "Reading…" : "Load tools"}
        </Button>
        <Button type="submit" disabled={saving || !ready}>
          {saving ? "Listing…" : refresh ? `Save ${picked.length ? `${picked.length} ` : ""}tools` : `List ${picked.length ? `${picked.length} ` : ""}tools`}
        </Button>
        {refresh ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">Reading a server is free; up to 20 checks per hour.</span>
      </div>

      <div aria-live="polite" className="flex flex-col gap-3">
        {error ? <p className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p> : null}
        {loaded ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
            <p className="text-xs text-muted-foreground">
              {loaded.tools.length} {loaded.tools.length === 1 ? "tool" : "tools"} on this server, {picked.length} picked (at most {MAX_TOOLS}). "Not declared" means the server does not say whether a tool changes data, so check it
              yourself.
            </p>
            {leaving.length ? <p className="text-xs text-warn">Saving takes {leaving.map((t) => t.name).join(", ")} off the marketplace.</p> : null}
            {tooMany ? <p className="text-xs text-bad">Untick {picked.length - MAX_TOOLS} to list the rest.</p> : null}
            <ul className="flex flex-col divide-y divide-border/60">
              {loaded.tools.map((t) => {
                const pick = pickFor(t.name);
                return (
                  <li key={t.name} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <input
                        id={`m-tool-${t.name}`}
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={pick.on}
                        disabled={!t.usable}
                        onChange={(e) => setPick(t.name, { on: e.target.checked })}
                      />
                      <label htmlFor={`m-tool-${t.name}`} className={"min-w-0 break-all font-mono text-xs " + (t.usable ? "text-foreground" : "text-muted-foreground line-through")}>
                        {t.name}
                      </label>
                      <span className={"rounded px-1.5 py-0.5 font-mono text-[10px] " + (t.access === "write" ? "bg-warn/15 text-warn" : "bg-muted text-muted-foreground")}>{ACCESS_LABEL[t.access]}</span>
                      {t.listedPrice ? <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">on sale</span> : null}
                      {t.usable ? (
                        <Input
                          aria-label={`Price per call for ${t.name}, in USDC`}
                          inputMode="decimal"
                          className="ml-auto h-7 w-24 font-mono text-xs"
                          value={pick.price}
                          disabled={!pick.on}
                          onChange={(e) => setPick(t.name, { price: e.target.value })}
                        />
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{t.description || (t.usable ? "" : "its input description is too large or not supported")}</p>
                    {t.access === "write" && pick.on ? <p className="text-xs text-warn">Anyone who pays can run this with your token.</p> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </form>
  );
}
