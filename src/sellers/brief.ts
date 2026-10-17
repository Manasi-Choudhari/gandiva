import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { usdcBalance } from "../agents/wallet.js";
import { isChainService } from "../chains/store.js";
import { canonical } from "../buyer/catalogue.js";
import { buyFrom, Ctx, type BuyOutcome, type PayFn, type RunState } from "../buyer/purchase.js";
import { config, fromUnits, toUnits } from "../config.js";
import { searchServices, type Category, type ServiceWithReputation } from "../registry/store.js";
import { BudgetLedger } from "../x402/budget.js";
import { ServiceError } from "../x402/paidRoute.js";
import { SafePayer } from "../x402/safePayer.js";
import { capForWallet } from "../x402/spendCap.js";
import { cityInput, cityOutput } from "./city.js";
import { fxInput, fxOutput, summariseInput, summariseOutput } from "./schemas.js";

export const BRIEF_ID = "travel-brief";
/** What one brief may spend on the sellers it hires: weather 0.002 + FX 0.001 + Hindi 0.010. The rest of the price is the seller's margin. */
export const BRIEF_SUB_BUDGET = toUnits("0.013");

export const briefInput = {
  type: "object",
  properties: {
    city: { type: "string", minLength: 1, maxLength: 80, description: "City name in English, e.g. Tokyo" },
    amount: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000, description: "Amount of money to convert into the city's local currency" },
    from: { type: "string", pattern: "^[A-Za-z]{3}$", description: "ISO 4217 code of that amount, e.g. GBP" },
    hindi: { type: "boolean", description: "Also return the brief summarised in Hindi" },
  },
  required: ["city", "amount", "from"],
  additionalProperties: false,
};

export const briefOutput = {
  type: "object",
  required: ["city", "country", "local_currency", "weather", "conversion", "brief", "hired", "cost_units"],
  properties: {
    city: { type: "string", minLength: 1 },
    country: { type: "string" },
    local_currency: { type: "string", pattern: "^[A-Z]{3}$" },
    weather: {
      type: "object",
      required: ["temperature_c", "wind_kmh", "conditions"],
      properties: { temperature_c: { type: "number" }, wind_kmh: { type: "number" }, conditions: { type: "string" } },
    },
    conversion: {
      type: "object",
      required: ["from", "to", "amount", "rate", "converted", "date"],
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        amount: { type: "number" },
        rate: { type: "number", exclusiveMinimum: 0 },
        converted: { type: "number" },
        date: { type: "string" },
      },
    },
    brief: { type: "string", minLength: 1 },
    brief_hi: { type: "string", pattern: "[\\u0900-\\u097F]" },
    hired: {
      type: "array",
      minItems: 1,
      description: "The sellers this agent paid to produce the brief, with the payment of each",
      items: {
        type: "object",
        required: ["service", "category", "status", "paid"],
        properties: {
          service: { type: "string" },
          category: { type: "string" },
          status: { type: "string" },
          paid: { type: "string", description: "USDC units paid" },
          tx_hash: { type: "string" },
        },
      },
    },
    cost_units: { type: "string", description: "Total USDC units this agent spent on the sellers it hired" },
  },
};

export const briefDescription =
  "One-call travel brief for a city: current weather, your money converted into the local currency, and an optional Hindi summary. " +
  "This agent does the work by hiring and paying other sellers (weather, FX, Hindi summary) itself and returns each payment it made.";

/** The sellers the brief may hire, found by what they do (their schemas), never by name, so a replacement seller can step in. */
const POOLS: Record<"weather" | "fx" | "hindi", { category: Category; key: string }> = {
  weather: { category: "data", key: canonical(["data", cityInput, cityOutput]) },
  fx: { category: "data", key: canonical(["data", fxInput, fxOutput]) },
  hindi: { category: "inference", key: canonical(["inference", summariseInput, summariseOutput]) },
};

/** Ranked suppliers for one job: never this agent itself or another chain, and only listings whose real 402 matched what they advertise. */
export function suppliers(all: ServiceWithReputation[], job: keyof typeof POOLS): ServiceWithReputation[] {
  const { category, key } = POOLS[job];
  return all.filter((s) => s.id !== BRIEF_ID && !isChainService(s.id) && s.verification === "verified" && s.category === category && canonical([s.category, s.inputSchema, s.outputSchema]) === key);
}

export interface BriefDeps {
  /** Pays one seller (the real thing is the travel-brief wallet's SafePayer). */
  pay: PayFn;
  address: string;
  /** USDC held by the wallet, in units. */
  balance: () => Promise<bigint>;
  services: () => ServiceWithReputation[];
  subBudget?: bigint;
}

let payer: SafePayer | undefined;

/** Why the agent cannot run, or undefined when its wallet is set up. */
export function briefUnavailable(): string | undefined {
  if (!config.travelBriefKey) return "TRAVEL_BRIEF_KEY is not set (run npm run wallets:new)";
  try {
    const address = privateKeyToAccount(config.travelBriefKey).address;
    if (address.toLowerCase() !== config.payTo.travelBrief.toLowerCase()) return "PAYTO_TRAVEL_BRIEF does not match TRAVEL_BRIEF_KEY (run npm run wallets:new)";
  } catch {
    return "TRAVEL_BRIEF_KEY is not a valid private key";
  }
  return undefined;
}

function defaultDeps(): BriefDeps {
  const why = briefUnavailable();
  if (why) throw new ServiceError(`travel-brief is not set up: ${why}`, 503);
  payer ??= new SafePayer(config.travelBriefKey as `0x${string}`, capForWallet(privateKeyToAccount(config.travelBriefKey as `0x${string}`).address));
  const p = payer;
  return { pay: (...args) => p.call(...args), address: p.address, balance: () => usdcBalance(p.address), services: () => searchServices() };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Builds the brief by hiring other sellers: weather (gives the local currency), then FX into that currency, then, if asked, a Hindi
 * summary of the finished text. Every payment goes through the same price check, schema check, budget and spend cap as Scout's.
 * Anything that fails throws before the buyer's payment settles, so the buyer is only charged for a complete brief.
 */
export async function travelBrief(input: { city: string; amount: number; from: string; hindi?: boolean }, deps: BriefDeps = defaultDeps()) {
  const subBudget = deps.subBudget ?? BRIEF_SUB_BUDGET;
  let held: bigint;
  try {
    held = await deps.balance();
  } catch (err: any) {
    throw new ServiceError(`cannot check the travel-brief wallet balance: ${err?.message ?? err}`, 503);
  }
  if (held < subBudget) throw new ServiceError(`travel-brief is out of float (${deps.address} holds ${fromUnits(held)} USDC, needs ${fromUnits(subBudget)}); try again later`, 503);

  const run = {
    id: `chain-${randomUUID().slice(0, 8)}`,
    task: `travel-brief for ${input.city}`,
    budget: subBudget.toString(),
    maxConcurrency: 1,
    state: "running",
    mode: "agent",
    dryRun: false,
    buyer: deps.address,
    log: [] as string[],
    purchases: [],
    startedAt: new Date().toISOString(),
  } as RunState;
  const ctx = new Ctx(run, new BudgetLedger(subBudget), 1, deps.pay);
  const all = deps.services();

  const hire = async (job: keyof typeof POOLS, step: string, callInput: Record<string, unknown>): Promise<any> => {
    const ranked = suppliers(all, job);
    if (!ranked.length) throw new ServiceError(`no verified ${job} seller is listed right now`, 503);
    const out: BuyOutcome = await buyFrom(ctx, `chain:${job}`, ranked, step, callInput);
    if (out.data === undefined) throw new ServiceError(`could not get ${step}: ${out.lastReason ?? out.stop ?? "no seller delivered"}`, 502);
    return out.data;
  };

  const city = await hire("weather", "weather", { name: input.city });
  const from = input.from.toUpperCase();
  const to = String(city.currency).toUpperCase();
  let rate = 1;
  let date = new Date().toISOString().slice(0, 10);
  if (from !== to) {
    const fx = await hire("fx", "exchange rate", { from, to });
    rate = fx.rate;
    date = fx.date;
  }
  const converted = round2(input.amount * rate);
  const brief =
    `${city.city}, ${city.country}: ${city.temperature_c}°C with ${city.conditions}, wind ${city.wind_kmh} km/h. ` +
    `${input.amount} ${from} is about ${converted} ${to} (rate ${rate}, ${date}).`;

  let briefHi: string | undefined;
  if (input.hindi) {
    const hi = await hire("hindi", "Hindi summary", { texts: [brief] });
    briefHi = hi.summaries[0].summary;
  }

  const paidRows = run.purchases.filter((p) => p.status === "paid" || p.status === "paid_output_rejected");
  const cost = paidRows.reduce((sum, p) => sum + BigInt(p.paid), 0n);
  return {
    city: String(city.city),
    country: String(city.country),
    local_currency: to,
    weather: { temperature_c: city.temperature_c, wind_kmh: city.wind_kmh, conditions: city.conditions },
    conversion: { from, to, amount: input.amount, rate, converted, date },
    brief,
    ...(briefHi ? { brief_hi: briefHi } : {}),
    hired: paidRows.map((p) => ({ service: p.service, category: p.category, status: p.status, paid: p.paid, ...(p.txHash ? { tx_hash: p.txHash } : {}) })),
    cost_units: cost.toString(),
  };
}
