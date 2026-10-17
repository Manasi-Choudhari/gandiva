"use client";

import { ServiceCard } from "@/components/market/service-card";
import { useInfo } from "@/lib/hooks";
import { short, toUnits, usdc } from "@/lib/format";
import type { Category, Service } from "@/lib/types";

const NETWORK = "eip155:84532";

export interface Draft {
  name: string;
  category: string;
  description: string;
  priceUsdc: string;
  endpoint: string;
  method: "GET" | "POST";
  wallet: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Set for an agent chain: the sellers it hires. */
  hires?: string[];
}

/** Why a typed price can't be listed, or null when it's fine. */
export function priceProblem(text: string): string | null {
  const units = toUnits(text);
  if (!units || Number(units) === 0) return "Price must be a number like 0.002 (USDC, up to 6 decimals).";
  if (Number(units) > 100_000) return "Price can be at most 0.10 USDC per call.";
  return null;
}

/** The base URL hosted agents are served from (for the LLM template's endpoint). */
export function usePublicBase() {
  return useInfo().data?.publicBaseUrl ?? "";
}

/**
 * How the listing will look in the Marketplace, updated as the seller types,
 * plus the 402 a buyer will get before paying.
 */
export function ListingPreview({ draft }: { draft: Draft }) {
  const network = useInfo().data?.network ?? NETWORK;
  const price = toUnits(draft.priceUsdc) ?? "0";
  const service: Service = {
    id: "preview",
    name: draft.name.trim() || "your-agent",
    category: draft.category as Category,
    endpoint: draft.endpoint.trim() || "https://…",
    method: draft.method,
    price,
    network,
    asset: "",
    payTo: draft.wallet,
    inputSchema: draft.inputSchema ?? {},
    outputSchema: draft.outputSchema ?? {},
    description: draft.description.trim(),
    owner: `wallet:${short(draft.wallet)}`,
    verification: "unchecked",
    verificationNote: "",
    verifiedAt: null,
    reputation: { attempts: 0, successes: 0, successRate: 0, medianLatencyMs: null, score: 0, isNew: true },
    chain: draft.hires?.length ? { hires: draft.hires } : null,
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[11px] tracking-[0.18em] text-muted-foreground uppercase">
        live preview · marketplace card
      </p>
      <ServiceCard service={service} index={0} />
      <div className="rounded-xl border border-border bg-background/70 p-3 font-mono text-[11px] leading-5">
        <div className="text-muted-foreground">what a buyer gets before paying</div>
        <div className="text-info">← 402 Payment Required</div>
        <div className="pl-4">
          price <span className="text-primary">{usdc(price)} USDC</span> · {network}
        </div>
        <div className="pl-4">payTo {short(draft.wallet)} ({draft.hires ? "your agent wallet" : "your wallet"})</div>
      </div>
    </div>
  );
}
