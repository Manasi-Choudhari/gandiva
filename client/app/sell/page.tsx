"use client";

import { useState } from "react";
import useSWR from "swr";
import { BotIcon, LinkIcon, PlugIcon } from "lucide-react";
import { useAuth } from "@/components/auth/auth-provider";
import { PageIntro } from "@/components/page-intro";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChainForm } from "@/components/sell/chain-form";
import { LlmAgentForm } from "@/components/sell/llm-agent-form";
import { ListingFormCard } from "@/components/sell/listing-form";
import { MyListings } from "@/components/sell/my-listings";
import { StakePanel } from "@/components/sell/stake-panel";
import { fetcher } from "@/lib/api";
import type { AgentInfo, ChainInfo, Service } from "@/lib/types";

type Template = "endpoint" | "llm" | "chain";

const TEMPLATES: { id: Template; title: string; text: string; icon: typeof PlugIcon }[] = [
  { id: "endpoint", title: "Bring your own endpoint", text: "You run a server that answers with an x402 402. List its URL, price and schemas.", icon: PlugIcon },
  { id: "llm", title: "LLM agent (Ollama)", text: "No server needed. Give a model, a system prompt and your Ollama key; we host the paid endpoint.", icon: BotIcon },
  { id: "chain", title: "Agent chain", text: "No server needed. Pick sellers to hire in order; your agent wallet pays them and keeps the margin.", icon: LinkIcon },
];

const verdict = (s: Service) => (s.verification === "verified" ? "402 matches" : s.verification === "mismatch" ? "402 does NOT match" : "endpoint could not be checked");

export default function SellPage() {
  const { address, loading, busy, signIn, error } = useAuth();
  const { data, mutate } = useSWR<{ address: string; services: Service[]; agents?: Record<string, AgentInfo>; chains?: Record<string, ChainInfo> }>(address ? "/registry/mine" : null, fetcher);
  const [template, setTemplate] = useState<Template>("endpoint");
  const [editing, setEditing] = useState<Service | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const agents = data?.agents ?? {};
  const chains = data?.chains ?? {};

  const pick = (t: Template) => {
    setTemplate(t);
    setEditing(null);
    setSaved(null);
  };
  const done = (s: Service) => {
    setSaved(`${s.name} is listed (${verdict(s)}).`);
    setEditing(null);
    void mutate();
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10">
      <PageIntro
        eyebrow="seller agents"
        title="Sell your own agent"
        description="List an agent that buyer agents can discover in the marketplace and pay your wallet per call over x402. The registry asks the endpoint for its 402 and flags it if the price or payee differs from what you list."
      />

      {!address ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-6">
            <p className="text-sm text-muted-foreground">
              {loading ? "Checking your session…" : "Sign in with your wallet to list a seller. Only your wallet can edit or delete what you list, and earnings go to it."}
            </p>
            {!loading ? (
              <Button onClick={signIn} disabled={busy}>
                {busy ? "Check your wallet…" : "Connect wallet"}
              </Button>
            ) : null}
            {error ? <p className="text-sm text-bad">{error}</p> : null}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="grid gap-3 sm:grid-cols-3">
            {TEMPLATES.map((t) => {
              const active = template === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pick(t.id)}
                  aria-pressed={active}
                  className={
                    "flex items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none " +
                    (active ? "border-primary/60 bg-primary/10" : "border-border/70 hover:border-primary/40 hover:bg-muted/40")
                  }
                >
                  <t.icon className={"mt-0.5 size-5 shrink-0 " + (active ? "text-primary" : "text-muted-foreground")} />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{t.title}</span>
                    <span className="text-xs text-muted-foreground">{t.text}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{editing ? `Edit ${editing.name}` : template === "llm" ? "List an LLM agent" : template === "chain" ? "List an agent chain" : "List a seller"}</CardTitle>
            </CardHeader>
            <CardContent>
              {template === "llm" ? (
                <LlmAgentForm
                  // a fresh form whenever another listing or template is picked
                  key={`llm:${editing?.id ?? "new"}`}
                  wallet={address}
                  editing={editing}
                  info={editing ? agents[editing.id] : undefined}
                  onCancel={() => setEditing(null)}
                  onSaved={done}
                />
              ) : template === "chain" ? (
                <ChainForm
                  key={`chain:${editing?.id ?? "new"}`}
                  wallet={address}
                  editing={editing}
                  info={editing ? chains[editing.id] : undefined}
                  onCancel={() => setEditing(null)}
                  onSaved={done}
                />
              ) : (
                <ListingFormCard key={`endpoint:${editing?.id ?? "new"}`} wallet={address} editing={editing} onCancel={() => setEditing(null)} onSaved={done} />
              )}
              {saved ? <p className="mt-3 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">{saved}</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Stake (seller bond)</CardTitle>
            </CardHeader>
            <CardContent>
              <StakePanel wallet={address} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>My listings</CardTitle>
            </CardHeader>
            <CardContent>
              <MyListings
                services={data?.services ?? []}
                agents={agents}
                chains={chains}
                onEdit={(s) => {
                  setSaved(null);
                  setTemplate(chains[s.id] ? "chain" : agents[s.id] ? "llm" : "endpoint");
                  setEditing(s);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                onChanged={() => void mutate()}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
