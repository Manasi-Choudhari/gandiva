import { fromUnits } from "../config.js";
import type { Category, ServiceWithReputation } from "../registry/store.js";

/**
 * Sellers whose category, input schema and output schema are identical do the same job, so the agent sees them as one
 * "group" and the executor picks and fails over between members. The handle is the best-ranked member's name.
 */
export interface ServiceGroup {
  handle: string;
  category: Category;
  key: string;
  memberIds: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  description: string;
  minPrice: bigint;
  maxPrice: bigint;
}

export const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

/** `ranked` must already be in the buyer's preference order (best first). */
export function groupServices(ranked: ServiceWithReputation[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const s of ranked) {
    // Two tools on one MCP server can share a schema and do opposite things (read_file, delete_file), so each is its own job.
    const key = canonical(s.access ? ["mcp-tool", s.id] : [s.category, s.inputSchema, s.outputSchema]);
    const price = BigInt(s.price);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { handle: s.name, category: s.category, key, memberIds: [s.id], inputSchema: s.inputSchema, outputSchema: s.outputSchema, description: s.description, minPrice: price, maxPrice: price });
    } else {
      g.memberIds.push(s.id);
      if (price < g.minPrice) g.minPrice = price;
      if (price > g.maxPrice) g.maxPrice = price;
    }
  }
  return [...groups.values()];
}

/** A call may name the group's handle or any member (by id or name, case-insensitive). */
export function findGroup(groups: ServiceGroup[], name: string, all: ServiceWithReputation[]): ServiceGroup | undefined {
  const n = name.trim().toLowerCase();
  const direct = groups.find((g) => g.handle.toLowerCase() === n);
  if (direct) return direct;
  const member = all.find((s) => s.id.toLowerCase() === n || s.name.toLowerCase() === n);
  return member ? groups.find((g) => g.memberIds.includes(member.id)) : undefined;
}

/**
 * Price to plan with for one call to a group: the dearest member that has not already proved unreliable. Cheaper members may
 * be the ones that misbehave (a greedy 402, junk output), so counting on them would understate the real bill.
 */
export function estimatePrice(members: ServiceWithReputation[]): bigint {
  if (!members.length) return 0n;
  const usable = members.filter((m) => m.reputation.score >= 0.5);
  const pool = usable.length ? usable : members;
  return pool.reduce((m, s) => (BigInt(s.price) > m ? BigInt(s.price) : m), 0n);
}

// ---- schema -> short text for the prompt ----------------------------------------------------------------------------

export function describeSchema(schema: any, depth = 0): string {
  if (!schema || typeof schema !== "object") return "any";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((v: unknown) => JSON.stringify(v)).join("|");
  const type = Array.isArray(schema.type) ? schema.type.filter((t: string) => t !== "null")[0] : schema.type;
  const nullable = Array.isArray(schema.type) && schema.type.includes("null") ? " or null" : "";
  if (type === "object" || schema.properties) {
    const required = new Set<string>(schema.required ?? []);
    const props = Object.entries(schema.properties ?? {}).map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${describeSchema(v, depth + 1)}`);
    return `{${props.join(", ")}}`;
  }
  if (type === "array") {
    const lo = schema.minItems, hi = schema.maxItems;
    const size = lo !== undefined || hi !== undefined ? ` (${lo ?? 0}-${hi ?? "any"} items)` : "";
    return `[${describeSchema(schema.items, depth + 1)}]${size}`;
  }
  if (type === "integer" || type === "number") {
    const range = schema.minimum !== undefined || schema.maximum !== undefined ? ` ${schema.minimum ?? ""}..${schema.maximum ?? ""}` : "";
    return `${type === "integer" ? "int" : "number"}${range}${nullable}`;
  }
  if (type === "string") {
    const bits = [schema.maxLength ? `max ${schema.maxLength} chars` : "", typeof schema.pattern === "string" && schema.pattern.includes("{3}") ? "3-letter code" : ""].filter(Boolean);
    return `string${bits.length ? ` (${bits.join(", ")})` : ""}${nullable}`;
  }
  return type ?? "any";
}

const usdc = (u: bigint) => fromUnits(u);

export function renderCatalogue(groups: ServiceGroup[]): string {
  return groups
    .map((g) => {
      const price = g.minPrice === g.maxPrice ? `${usdc(g.minPrice)}` : `${usdc(g.minPrice)}-${usdc(g.maxPrice)}`;
      const alt = g.memberIds.length > 1 ? ` (interchangeable sellers: ${g.memberIds.length}; the system picks and fails over)` : "";
      return [`- "${g.handle}" [${g.category}] ${price} USDC per call${alt}`, `    does: ${g.description}`, `    input: ${describeSchema(g.inputSchema)}`, `    output: ${describeSchema(g.outputSchema)}`].join("\n");
    })
    .join("\n");
}

// ---- dry-run sample data --------------------------------------------------------------------------------------------

/**
 * Plausible placeholder output built from an output schema, so a dry run can plan multi-step chains without paying.
 * `idx` varies the values between list items (ratings 5, 4, 3 ...; rising prices) so filters and sorts have something to do.
 */
export function sampleFromSchema(schema: any, idx = 0): unknown {
  if (!schema || typeof schema !== "object") return "sample";
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[idx % schema.enum.length];
  const type = Array.isArray(schema.type) ? schema.type.filter((t: string) => t !== "null")[0] : schema.type;
  if (type === "object" || schema.properties) return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sampleFromSchema(v, idx)]));
  if (type === "array") {
    const lo = schema.minItems ?? 0;
    const hi = schema.maxItems ?? 3;
    const n = Math.min(Math.max(3, lo), hi);
    return Array.from({ length: n }, (_, i) => sampleFromSchema(schema.items, i));
  }
  if (type === "integer") return Math.max(schema.minimum ?? -Infinity, (schema.maximum ?? 1) - idx);
  if (type === "number") return (schema.exclusiveMinimum ?? schema.minimum ?? 0) + 1 + idx;
  if (type === "boolean") return true;
  if (type === "string") {
    const p: string = schema.pattern ?? "";
    if (p.includes("{3}")) return "USD";
    if (p.includes("{2}")) return "US";
    return idx ? `sample text ${idx + 1}` : "sample text";
  }
  return "sample";
}
