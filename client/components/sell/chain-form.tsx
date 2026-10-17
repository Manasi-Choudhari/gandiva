"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { quoteChain, saveChain, testChain } from "@/lib/api";
import { explorerTx, short, statusLabel, toUnits, usdc } from "@/lib/format";
import { useAgentWallet, useServices } from "@/lib/hooks";
import type { ChainInfo, ChainQuote, ChainStepForm, ChainTestResult, Service } from "@/lib/types";
import { ChainStepEditor, parseValue, props, requiredOf } from "./chain-step-editor";
import { ListingPreview, priceProblem, usePublicBase } from "./listing-preview";
import { Wizard, type WizardStep } from "./wizard";

const MIN_STEPS = 2;
const MAX_STEPS = 3;

/** Same rule as the server's listing ids (src/registry/store.ts slug). */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);

interface FormState {
  name: string;
  description: string;
  priceUsdc: string;
  /** Empty = the steps' total at today's prices. */
  subBudgetUsdc: string;
  steps: ChainStepForm[];
}

const emptyStep = (): ChainStepForm => ({ serviceId: "", input: {} });
const STARTER: FormState = { name: "", description: "", priceUsdc: "0.02", subBudgetUsdc: "", steps: [emptyStep(), emptyStep()] };

export function ChainForm({
  wallet,
  editing,
  info,
  onSaved,
  onCancel,
}: {
  wallet: string;
  editing: Service | null;
  info?: ChainInfo;
  onSaved: (s: Service) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() =>
    editing && info
      ? { name: editing.name, description: editing.description, priceUsdc: usdc(editing.price), subBudgetUsdc: usdc(info.subBudget), steps: info.steps.map((s) => ({ serviceId: s.serviceId, input: s.input })) }
      : STARTER,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last server quote, tagged with the form it was for (a stale one is ignored).
  const [quoted, setQuoted] = useState<{ key: string; quote: ChainQuote | null; error: string | null } | null>(null);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: true; data: ChainTestResult } | { ok: false; text: string } | null>(null);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const publicBase = usePublicBase();
  const agentWallet = useAgentWallet(true).data;

  // Sellers a chain may hire: their 402 was verified, and they are not chains themselves.
  const eligible = (useServices().data?.services ?? []).filter((s) => s.verification === "verified" && !s.chain && s.id !== editing?.id);
  const chosen = form.steps.map((s) => eligible.find((e) => e.id === s.serviceId));
  const autoSub = chosen.reduce((sum, s) => sum + (s ? Number(s.price) : 0), 0);
  const price = toUnits(form.priceUsdc);
  const subBudget = form.subBudgetUsdc.trim() ? toUnits(form.subBudgetUsdc) : String(autoSub);

  const stepsProblem = (() => {
    if (form.steps.length < MIN_STEPS) return `Add at least ${MIN_STEPS} sellers to hire.`;
    for (const [i, step] of form.steps.entries()) {
      const svc = chosen[i];
      if (!svc) return `Pick a seller for step ${i + 1}.`;
      const missing = requiredOf(svc.inputSchema).find((f) => !step.input[f]);
      if (missing) return `Step ${i + 1}: choose where "${missing}" comes from.`;
    }
    return null;
  })();
  const payload = price && subBudget ? { ...(editing ? { id: editing.id } : {}), price, subBudget, steps: form.steps } : null;
  const payloadKey = stepsProblem || !payload ? "" : JSON.stringify(payload);
  const current = quoted && quoted.key === payloadKey && payloadKey ? quoted : null;
  const quote = current?.quote ?? null;
  const quoteError = current?.error ?? null;

  // A fresh server quote (validation, cost, margin, the listing it becomes) whenever the steps or money change. Free.
  useEffect(() => {
    if (!payloadKey) return;
    let live = true;
    const t = setTimeout(() => {
      quoteChain(JSON.parse(payloadKey))
        .then((q) => live && setQuoted({ key: payloadKey, quote: q, error: null }))
        .catch((e) => live && setQuoted({ key: payloadKey, quote: null, error: e instanceof Error ? e.message : "Could not check the chain." }));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [payloadKey]);

  const fields = props(quote?.inputSchema);
  const sampleInput = () => Object.fromEntries(Object.entries(fields).filter(([f]) => (sample[f] ?? "").trim() !== "").map(([f, schema]) => [f, parseValue(sample[f], schema)]));

  async function test() {
    if (!payload) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult({ ok: true, data: await testChain({ ...payload, input: sampleInput() }) });
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : "Test failed." });
    } finally {
      setTesting(false);
    }
  }

  /** True when a new chain was saved, so the wizard starts over. */
  async function submit(): Promise<boolean> {
    setError(null);
    if (!payload) {
      setError("Check the price and the sub-budget.");
      return false;
    }
    setSaving(true);
    try {
      const saved = await saveChain({ ...payload, name: form.name.trim(), description: form.description.trim() });
      onSaved(saved);
      if (!editing) {
        setForm(STARTER);
        setTestResult(null);
      }
      return !editing;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the chain.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const setStep = (i: number, s: ChainStepForm) =>
    // A later step may use this one's output: when its seller changes, those mappings are cleared.
    set({
      steps: form.steps.map((x, j) => {
        if (j === i) return s;
        if (j < i || s.serviceId === form.steps[i].serviceId) return x;
        return { ...x, input: Object.fromEntries(Object.entries(x.input).filter(([, src]) => !(src.from === "step" && src.step === i + 1))) };
      }),
    });

  const steps: WizardStep[] = [
    {
      title: "Basics",
      hint: "An agent that does its job by hiring other sellers.",
      problem: !form.name.trim()
        ? "Give your chain a name."
        : form.description.trim().length < 10
          ? "Say what it does (at least 10 characters); buyer agents read this to decide whether to hire you."
          : priceProblem(form.priceUsdc),
      content: (
        <>
          <p className="text-sm text-muted-foreground">
            A buyer pays your price; your chain then hires each seller you pick, in order, paying them from your <span className="text-foreground">agent wallet</span>. Earnings also go to that wallet, so every sale refills it. If any step fails, the buyer is not charged.
          </p>
          <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="c-name" className="text-xs text-muted-foreground">
                Name
              </Label>
              <Input id="c-name" className="font-mono" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="tokyo-brief" disabled={Boolean(editing)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="c-price" className="text-xs text-muted-foreground">
                Price (USDC / call)
              </Label>
              <Input id="c-price" inputMode="decimal" className="font-mono" value={form.priceUsdc} onChange={(e) => set({ priceUsdc: e.target.value })} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="c-desc" className="text-xs text-muted-foreground">
              What does it do? (buyer agents read this to decide whether to hire you)
            </Label>
            <Input id="c-desc" value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Weather for a city, your money in its currency, and a Hindi line." maxLength={400} />
          </div>
        </>
      ),
    },
    {
      title: "Steps",
      hint: `Pick ${MIN_STEPS} to ${MAX_STEPS} sellers in order, and where each of their inputs comes from.`,
      problem: stepsProblem,
      content: (
        <div className="flex flex-col gap-3">
          {eligible.length === 0 ? <p className="text-sm text-warn">No verified sellers are listed yet.</p> : null}
          {form.steps.map((step, i) => (
            <ChainStepEditor
              key={i}
              index={i}
              step={step}
              earlier={chosen.slice(0, i)}
              services={eligible}
              onChange={(s) => setStep(i, s)}
              onRemove={form.steps.length > MIN_STEPS && i === form.steps.length - 1 ? () => set({ steps: form.steps.slice(0, -1) }) : undefined}
            />
          ))}
          {form.steps.length < MAX_STEPS ? (
            <Button type="button" variant="outline" className="self-start" onClick={() => set({ steps: [...form.steps, emptyStep()] })}>
              <PlusIcon /> Add a step
            </Button>
          ) : null}
        </div>
      ),
    },
    {
      title: "Money",
      hint: "What each call costs you, what you keep, and whether your agent wallet can pay.",
      problem: !subBudget ? "The sub-budget must be a number like 0.013." : quoteError ?? (quote ? null : "Checking the chain…"),
      content: (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="c-sub" className="text-xs text-muted-foreground">
              Most one call may spend on its steps (USDC)
            </Label>
            <Input id="c-sub" inputMode="decimal" className="font-mono" value={form.subBudgetUsdc} placeholder={usdc(autoSub)} onChange={(e) => set({ subBudgetUsdc: e.target.value })} />
            <span className="text-[11px] text-muted-foreground">Leave empty for today&apos;s total. It must cover the steps and stay within your price.</span>
          </div>
          {quote ? (
            <div className="rounded-lg border border-border/70 p-3 font-mono text-xs">
              {quote.steps.map((s, i) => (
                <div key={i} className="flex justify-between gap-2">
                  <span>
                    step {i + 1} · {s.name}
                  </span>
                  <span>{usdc(s.price)}</span>
                </div>
              ))}
              <div className="mt-2 flex justify-between gap-2 border-t border-border pt-2">
                <span>cost per call</span>
                <span>{usdc(quote.cost)} USDC</span>
              </div>
              <div className="flex justify-between gap-2">
                <span>your price</span>
                <span>{usdc(quote.price)} USDC</span>
              </div>
              <div className="flex justify-between gap-2 text-primary">
                <span>you keep</span>
                <span>{usdc(quote.margin)} USDC</span>
              </div>
            </div>
          ) : null}
          {quote ? (
            <div className={"rounded-lg border px-3 py-2 text-sm " + (quote.agentWallet.enough === false ? "border-warn/40 bg-warn/10 text-warn" : "border-border/70 text-muted-foreground")}>
              Agent wallet {short(quote.agentWallet.address)} holds {quote.agentWallet.balance === null ? "an unknown amount of" : `${usdc(quote.agentWallet.balance)}`} USDC.{" "}
              {quote.agentWallet.enough === false ? (
                <>
                  It needs at least {usdc(quote.subBudget)} USDC to take a call:{" "}
                  <Link href="/marketplace" className="underline">
                    add funds on the Marketplace
                  </Link>
                  .
                </>
              ) : (
                "Each call reserves the sub-budget before hiring anyone."
              )}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: "Try & list",
      hint: "Optionally run it once for real before buyers can pay for it.",
      problem: null,
      content: (
        <div className="flex flex-col gap-3 rounded-lg border border-border/70 p-3">
          <p className="text-xs text-muted-foreground">
            A test run hires the real sellers and pays them from your agent wallet (up to {usdc(quote?.subBudget ?? subBudget ?? "0")} USDC). Only you can run it, up to 10 times an hour.
          </p>
          {Object.keys(fields).length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(fields).map(([f, schema]) => (
                <div key={f} className="flex flex-col gap-1.5">
                  <Label htmlFor={`c-sample-${f}`} className="text-xs text-muted-foreground">
                    {f}
                    {requiredOf(quote?.inputSchema).includes(f) ? " *" : ""}
                  </Label>
                  <Input
                    id={`c-sample-${f}`}
                    className="font-mono"
                    value={sample[f] ?? ""}
                    placeholder={schema.description?.slice(0, 60) ?? ""}
                    onChange={(e) => setSample((s) => ({ ...s, [f]: e.target.value }))}
                    onKeyDown={(e) => {
                      // Enter here does not list the chain.
                      if (e.key === "Enter") e.preventDefault();
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">The buyer sends no input: every field is fixed or comes from a step.</p>
          )}
          <Button type="button" variant="outline" className="self-start" onClick={test} disabled={testing || !quote || quote.agentWallet.enough === false}>
            {testing ? "Hiring the sellers…" : `Paid test run (up to ${usdc(quote?.subBudget ?? "0")} USDC)`}
          </Button>
          <div aria-live="polite">
            {testResult?.ok === false ? <pre className="whitespace-pre-wrap rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{testResult.text}</pre> : null}
            {testResult?.ok ? (
              <div className="flex flex-col gap-2 rounded-md bg-muted px-3 py-2 text-xs">
                <div className="font-medium">
                  Done in {(testResult.data.ms / 1000).toFixed(1)} s, paid {usdc(testResult.data.output.cost_units)} USDC to {testResult.data.output.hired.length} seller(s):
                </div>
                <ul className="flex flex-col gap-0.5 font-mono">
                  {testResult.data.output.hired.map((h, i) => (
                    <li key={i}>
                      {h.service} · {statusLabel(h.status)} · {usdc(h.paid)} USDC
                      {h.tx_hash ? (
                        <>
                          {" · "}
                          <a href={explorerTx(h.tx_hash) ?? "#"} target="_blank" rel="noreferrer" className="underline">
                            tx
                          </a>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(testResult.data.output.result, null, 2).slice(0, 4000)}</pre>
              </div>
            ) : null}
          </div>
        </div>
      ),
    },
  ];

  const id = editing?.id ?? (slug(form.name) || "your-chain");
  const last = chosen[chosen.length - 1];

  return (
    <Wizard
      steps={steps}
      submitting={saving}
      error={error}
      submitLabel={editing ? "Save changes" : "List my chain"}
      submittingLabel="Saving…"
      onSubmit={submit}
      onCancel={editing ? onCancel : undefined}
      preview={
        <ListingPreview
          draft={{
            name: form.name,
            category: quote?.category ?? last?.category ?? "inference",
            description: form.description,
            priceUsdc: form.priceUsdc,
            endpoint: `${publicBase}/sellers/c/${id}/run`,
            method: "POST",
            wallet: quote?.agentWallet.address ?? agentWallet?.address ?? wallet,
            inputSchema: quote?.inputSchema,
            outputSchema: quote?.outputSchema,
            hires: chosen.flatMap((s) => (s ? [s.id] : [])),
          }}
        />
      }
    />
  );
}
