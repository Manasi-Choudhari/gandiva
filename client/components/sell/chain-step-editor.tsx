"use client";

import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usdc } from "@/lib/format";
import type { ChainSource, ChainStepForm, JsonSchema, Service } from "@/lib/types";

type Schema = JsonSchema;

export const props = (s: Schema | Record<string, unknown> | undefined): Record<string, Schema> => {
  const p = (s as Schema | undefined)?.properties;
  return p && typeof p === "object" ? p : {};
};
export const requiredOf = (s: Schema | Record<string, unknown> | undefined): string[] => {
  const r = (s as Schema | undefined)?.required;
  return Array.isArray(r) ? r : [];
};

function typesOf(s: Schema | undefined): Set<string> | null {
  if (!s) return null;
  if (typeof s.type === "string") return new Set([s.type]);
  if (Array.isArray(s.type)) return new Set(s.type);
  return null;
}
const takes = (t: Set<string>, x: string) => t.has(x) || (x === "integer" && t.has("number"));

/** Same rule as the server (src/chains/chains.ts fit): can a value of `src` fill a field of `tgt`, as is or as a one-item list? */
export function fits(src: Schema | undefined, tgt: Schema | undefined): boolean {
  const s = typesOf(src);
  const t = typesOf(tgt);
  if (!s || !t) return true;
  const real = [...s].filter((x) => x !== "null");
  if (!real.length) return false;
  if (real.every((x) => takes(t, x))) return true;
  if (!t.has("array")) return false;
  const items = typesOf(tgt?.items);
  return !items || real.every((x) => takes(items, x));
}

const typeLabel = (s: Schema | undefined) => [...(typesOf(s) ?? ["any"])].join(" / ");

/** Text typed into a box -> the JSON value the field's schema expects. */
export function parseValue(text: string, schema: Schema | undefined): unknown {
  const t = typesOf(schema);
  if (t?.has("number") || t?.has("integer")) {
    const n = Number(text);
    return text.trim() !== "" && Number.isFinite(n) ? n : text;
  }
  if (t?.has("boolean")) return text.trim().toLowerCase() === "true";
  if (t?.has("array")) return text.split(",").map((x) => x.trim()).filter(Boolean);
  return text;
}
export const showValue = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v));

/** A buyer field name made from an input field name (the server allows a-z, 0-9 and _). */
export const fieldName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 40) || "value";

/** Where each field comes from when a seller is first picked: an earlier output with the same name, else the buyer. */
export function defaultInput(svc: Service, earlier: (Service | undefined)[]): Record<string, ChainSource> {
  const out: Record<string, ChainSource> = {};
  for (const field of requiredOf(svc.inputSchema)) {
    const tgt = props(svc.inputSchema)[field];
    const k = earlier.findIndex((e) => e && field in props(e.outputSchema) && fits(props(e.outputSchema)[field], tgt));
    out[field] = k >= 0 ? { from: "step", step: k + 1, field } : { from: "buyer", field: fieldName(field) };
  }
  return out;
}

const encode = (src: ChainSource | undefined) => (!src ? "none" : src.from === "step" ? `step:${src.step}:${src.field}` : src.from);

export function ChainStepEditor({
  index,
  step,
  earlier,
  services,
  onChange,
  onRemove,
}: {
  index: number;
  step: ChainStepForm;
  /** The services chosen in the steps before this one (their outputs can feed this step). */
  earlier: (Service | undefined)[];
  /** Sellers a chain may hire: verified, not chains. */
  services: Service[];
  onChange: (s: ChainStepForm) => void;
  onRemove?: () => void;
}) {
  const svc = services.find((s) => s.id === step.serviceId);
  const fields = props(svc?.inputSchema);
  const required = requiredOf(svc?.inputSchema);

  const setSource = (field: string, src: ChainSource | undefined) => {
    const input = { ...step.input };
    if (src) input[field] = src;
    else delete input[field];
    onChange({ ...step, input });
  };

  function pick(field: string, value: string) {
    if (value === "none") return setSource(field, undefined);
    if (value === "buyer") return setSource(field, { from: "buyer", field: fieldName(field) });
    if (value === "fixed") return setSource(field, { from: "fixed", value: parseValue("", fields[field]) });
    const [, k, f] = value.split(":");
    setSource(field, { from: "step", step: Number(k), field: f });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/70 p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 font-mono text-xs text-primary">{index + 1}</span>
        <Select
          value={step.serviceId || undefined}
          onValueChange={(id) => {
            const chosen = services.find((s) => s.id === id);
            onChange({ serviceId: id, input: chosen ? defaultInput(chosen, earlier) : {} });
          }}
        >
          <SelectTrigger aria-label={`Seller for step ${index + 1}`} className="w-full font-mono">
            <SelectValue placeholder="Pick a seller to hire" />
          </SelectTrigger>
          <SelectContent>
            {services.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name} · {s.category} · {usdc(s.price)} USDC
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {onRemove ? (
          <Button type="button" size="icon" variant="ghost" onClick={onRemove} aria-label={`Remove step ${index + 1}`}>
            <XIcon />
          </Button>
        ) : null}
      </div>

      {svc ? (
        <>
          <p className="text-xs text-muted-foreground">{svc.description}</p>
          {Object.keys(fields).length ? (
            <div className="flex flex-col gap-2">
              {Object.entries(fields).map(([field, schema]) => {
                const src = step.input[field];
                const options = earlier.flatMap((e, k) =>
                  e
                    ? Object.entries(props(e.outputSchema))
                        .filter(([, out]) => fits(out, schema))
                        .map(([f]) => ({ value: `step:${k + 1}:${f}`, label: `Step ${k + 1} (${e.name}) → ${f}` }))
                    : [],
                );
                return (
                  <div key={field} className="grid gap-2 rounded-md bg-muted/40 p-2 sm:grid-cols-[10rem_1fr_1fr] sm:items-center">
                    <div className="flex flex-col">
                      <span className="font-mono text-xs">
                        {field}
                        {required.includes(field) ? <span className="text-bad"> *</span> : null}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">{typeLabel(schema)}</span>
                    </div>
                    <Select value={encode(src)} onValueChange={(v) => pick(field, v)}>
                      <SelectTrigger aria-label={`Where ${field} comes from`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {!required.includes(field) ? <SelectItem value="none">Leave empty</SelectItem> : null}
                        <SelectItem value="buyer">Buyer provides</SelectItem>
                        <SelectItem value="fixed">Fixed value</SelectItem>
                        {options.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {src?.from === "buyer" ? (
                      <div className="flex flex-col gap-0.5">
                        <Label htmlFor={`f-${index}-${field}`} className="sr-only">
                          Buyer field name for {field}
                        </Label>
                        <Input id={`f-${index}-${field}`} className="font-mono" value={src.field} onChange={(e) => setSource(field, { from: "buyer", field: fieldName(e.target.value) })} />
                      </div>
                    ) : src?.from === "fixed" ? (
                      <div className="flex flex-col gap-0.5">
                        <Label htmlFor={`f-${index}-${field}`} className="sr-only">
                          Fixed value for {field}
                        </Label>
                        <Input
                          id={`f-${index}-${field}`}
                          className="font-mono"
                          value={showValue(src.value)}
                          placeholder={typesOf(schema)?.has("array") ? "comma, separated" : "value"}
                          onChange={(e) => setSource(field, { from: "fixed", value: parseValue(e.target.value, schema) })}
                        />
                      </div>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">{src?.from === "step" ? "filled from an earlier step" : "not sent"}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">This seller takes no input.</p>
          )}
        </>
      ) : null}
    </div>
  );
}
