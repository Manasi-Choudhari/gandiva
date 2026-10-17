"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { saveListing, type ListingForm } from "@/lib/api";
import { toUnits, usdc } from "@/lib/format";
import type { Service } from "@/lib/types";
import { ListingPreview, priceProblem } from "./listing-preview";
import { Wizard, type WizardStep } from "./wizard";

const FIELD =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

interface FormState {
  id?: string;
  name: string;
  category: string;
  priceUsdc: string;
  endpoint: string;
  method: "GET" | "POST";
  description: string;
  inputSchema: string;
  outputSchema: string;
}

const STARTER: FormState = {
  name: "",
  category: "data",
  priceUsdc: "0.002",
  endpoint: "",
  method: "GET",
  description: "",
  inputSchema: JSON.stringify({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }, null, 2),
  outputSchema: JSON.stringify({ type: "object", properties: { temperature_c: { type: "number" } }, required: ["temperature_c"] }, null, 2),
};

export const fromService = (s: Service): FormState => ({
  id: s.id,
  name: s.name,
  category: s.category,
  priceUsdc: usdc(s.price),
  endpoint: s.endpoint,
  method: s.method,
  description: s.description,
  inputSchema: JSON.stringify(s.inputSchema, null, 2),
  outputSchema: JSON.stringify(s.outputSchema, null, 2),
});

function parseSchema(label: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object, e.g. { "type": "object" }.`);
  return value as Record<string, unknown>;
}

function schemaProblem(label: string, text: string): string | null {
  try {
    parseSchema(label, text);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function parsedOrUndefined(text: string) {
  try {
    return parseSchema("", text);
  } catch {
    return undefined;
  }
}

function endpointProblem(text: string): string | null {
  const url = text.trim();
  if (!url) return "Add the URL buyers will call.";
  try {
    if (/^https?:$/.test(new URL(url).protocol)) return null;
  } catch {
    // not a URL at all; fall through
  }
  return "The endpoint must be a full http(s) URL, like https://my-server.example/weather.";
}

export function ListingFormCard({
  wallet,
  editing,
  onSaved,
  onCancel,
}: {
  wallet: string;
  editing: Service | null;
  onSaved: (s: Service) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => (editing ? fromService(editing) : STARTER));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  /** True when a new listing was saved, so the wizard starts over. */
  async function submit(): Promise<boolean> {
    setError(null);
    try {
      const price = toUnits(form.priceUsdc);
      if (!price || Number(price) === 0) throw new Error("Price must be a number like 0.002 (USDC, up to 6 decimals).");
      if (Number(price) > 100_000) throw new Error("Price can be at most 0.10 USDC per call.");
      const body: ListingForm = {
        ...(form.id ? { id: form.id } : {}),
        name: form.name.trim(),
        category: form.category,
        endpoint: form.endpoint.trim(),
        method: form.method,
        price,
        description: form.description.trim(),
        inputSchema: parseSchema("Input schema", form.inputSchema),
        outputSchema: parseSchema("Output schema", form.outputSchema),
      };
      setSaving(true);
      const saved = await saveListing(body);
      onSaved(saved);
      if (!editing) setForm(STARTER);
      return !editing;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the listing.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const inputProblem = schemaProblem("Input schema", form.inputSchema);
  const outputProblem = schemaProblem("Output schema", form.outputSchema);

  const steps: WizardStep[] = [
    {
      title: "Basics",
      hint: "What buyer agents see when they browse the marketplace.",
      problem: form.name.trim() ? null : "Give your seller a name.",
      content: (
        <>
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name" className="text-xs text-muted-foreground">
                Name
              </Label>
              <Input id="name" className="font-mono" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="my-weather-api" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="category" className="text-xs text-muted-foreground">
                Category
              </Label>
              <Select value={form.category} onValueChange={(v) => set({ category: v })}>
                <SelectTrigger id="category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="data">data</SelectItem>
                  <SelectItem value="inference">inference</SelectItem>
                  <SelectItem value="scraping">scraping</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description" className="text-xs text-muted-foreground">
              Description
            </Label>
            <Input id="description" value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="What does it do? (the buyer agent reads this)" />
          </div>
        </>
      ),
    },
    {
      title: "Endpoint & price",
      hint: "Where buyers call you, and what each call costs.",
      problem: endpointProblem(form.endpoint) ?? priceProblem(form.priceUsdc),
      content: (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="endpoint" className="text-xs text-muted-foreground">
              Endpoint URL (must answer with an x402 402 before payment)
            </Label>
            <Input id="endpoint" className="font-mono" value={form.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://my-server.example/weather" />
          </div>
          <div className="grid grid-cols-2 gap-4 sm:max-w-sm">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="method" className="text-xs text-muted-foreground">
                Method
              </Label>
              <Select value={form.method} onValueChange={(v) => set({ method: v as "GET" | "POST" })}>
                <SelectTrigger id="method" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="price" className="text-xs text-muted-foreground">
                Price (USDC / call)
              </Label>
              <Input id="price" inputMode="decimal" className="font-mono" value={form.priceUsdc} onChange={(e) => set({ priceUsdc: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Payments go to your signed-in wallet <span className="font-mono break-all text-foreground">{wallet}</span>. Your endpoint&apos;s 402 must ask for this price and payTo, or the listing is flagged.
          </p>
        </>
      ),
    },
    {
      title: "Schemas & list",
      hint: "The buyer checks your answer against the output schema before it pays.",
      problem: inputProblem ?? outputProblem,
      content: (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <SchemaField id="input" label="Input schema (JSON Schema of the query or body)" value={form.inputSchema} problem={inputProblem} onChange={(v) => set({ inputSchema: v })} />
            <SchemaField id="output" label="Output schema (JSON Schema of the answer)" value={form.outputSchema} problem={outputProblem} onChange={(v) => set({ outputSchema: v })} />
          </div>
          <p className="text-xs text-muted-foreground">
            When you list it, the registry asks your endpoint for its 402 and shows whether it matches what you listed here.
          </p>
        </>
      ),
    },
  ];

  return (
    <Wizard
      steps={steps}
      submitting={saving}
      error={error}
      submitLabel={editing ? "Save changes" : "List my seller"}
      submittingLabel="Saving and checking the endpoint…"
      onSubmit={submit}
      onCancel={editing ? onCancel : undefined}
      preview={
        <ListingPreview
          draft={{
            ...form,
            wallet,
            inputSchema: parsedOrUndefined(form.inputSchema),
            outputSchema: parsedOrUndefined(form.outputSchema),
          }}
        />
      }
    />
  );
}

function SchemaField({
  id,
  label,
  value,
  problem,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  problem: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <textarea
        id={id}
        rows={8}
        spellCheck={false}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-check`}
        className={FIELD + " resize-y font-mono text-xs aria-invalid:border-warn"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={`${id}-check`} className={"font-mono text-[11px] " + (problem ? "text-warn" : "text-ok")}>
        {problem ?? "valid JSON object"}
      </span>
    </div>
  );
}
