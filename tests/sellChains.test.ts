import { encodePaymentSignatureHeader } from "@x402/core/http";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loginMessage } from "../src/auth/session.js";
import { config, NETWORK } from "../src/config.js";
import { db } from "../src/db.js";
import type { BudgetLedger } from "../src/x402/budget.js";
import type { CallResult } from "../src/x402/safePayer.js";
import { accept, SELLER, service } from "./helpers.js";

const fake = vi.hoisted(() => ({ settleCalls: 0, balance: 0n }));

// The paid route runs for real; only the facilitator is faked (requirements follow the route's own payTo and price).
vi.mock("../src/x402/resourceServer.js", async () => {
  const { accept } = await import("./helpers.js");
  return {
    getResourceServer: async () => ({
      buildPaymentRequirements: async (o: any) => accept({ payTo: o.payTo, amount: o.price.amount }),
      createPaymentRequiredResponse: async (reqs: unknown, resource: unknown, error: string) => ({ x402Version: 2, error, resource, accepts: [reqs] }),
      findMatchingRequirements: (reqs: any) => reqs[0] ?? reqs,
      verifyPayment: async () => ({ isValid: true }),
      settlePayment: async () => {
        fake.settleCalls++;
        return { success: true, transaction: "0x" + "ab".repeat(32), network: NETWORK, payer: "0x" + "99".repeat(20) };
      },
    }),
  };
});
// No chain reads: the agent wallet "holds" whatever the test says.
vi.mock("../src/agents/wallet.js", async (importOriginal) => ({ ...(await importOriginal<any>()), usdcBalance: async () => fake.balance }));

const { auth } = await import("../src/auth/routes.js");
const { registry } = await import("../src/registry/routes.js");
const { buildSellers, sellerDefs } = await import("../src/sellers/index.js");
const { ensureAgentWallet } = await import("../src/agents/wallet.js");
const { fit, planChain, runChain, ChainError, MAX_CONCURRENT } = await import("../src/chains/chains.js");
const { getChain, upsertChain } = await import("../src/chains/store.js");
const { getService, setVerification, upsertService } = await import("../src/registry/store.js");
const { ServiceError } = await import("../src/x402/paidRoute.js");
const { validate } = await import("../src/x402/schema.js");
const { summariseOutput } = await import("../src/sellers/schemas.js");

// ---- fixtures -------------------------------------------------------------------------------------------------------

const rep = { attempts: 5, successes: 5, successRate: 1, medianLatencyMs: 50, score: 1, isNew: false };
const listed = (over: Record<string, Partial<ReturnType<typeof service>>> = {}) =>
  sellerDefs().map((d) => ({
    ...service({ id: d.id, name: d.name, category: d.category, price: d.listedPrice.toString(), inputSchema: d.inputSchema, outputSchema: d.outputSchema, description: d.description, verification: "verified" }),
    ...over[d.id],
    reputation: rep,
  }));
const lookupIn = (list: ReturnType<typeof listed>) => (id: string) => list.find((s) => s.id === id);

/** city-info -> fx-rates (to = the city's currency) -> hindi-summary of the weather conditions. */
const travel = (over: Record<string, unknown> = {}): any => ({
  price: "20000",
  subBudget: "13000",
  steps: [
    { serviceId: "city-info", input: { name: { from: "buyer", field: "city" } } },
    { serviceId: "fx-rates", input: { from: { from: "buyer", field: "currency" }, to: { from: "step", step: 1, field: "currency" } } },
    { serviceId: "hindi-summary", input: { texts: { from: "step", step: 1, field: "conditions" } } },
  ],
  ...over,
});
const withStep = (i: number, step: unknown) => {
  const t = travel();
  t.steps[i] = step as any;
  return t;
};

/** Pays like the marketplace would: reserves from the chain's sub-budget, then returns what each seller would return. */
function fakePay(hold?: Promise<void>) {
  const calls: { id: string; input: any }[] = [];
  const pay = async (s: any, input: any, ctx: { budget: BudgetLedger }): Promise<CallResult> => {
    calls.push({ id: s.id, input });
    if (hold) await hold;
    const base = { latencyMs: 5, ledgerId: calls.length };
    const price = BigInt(s.price);
    const r = await ctx.budget.reserve(price);
    if (!r) return { ...base, status: "refused", ok: false, paid: 0n, asked: price, reason: `budget: needs ${price} but only ${ctx.budget.remaining} is left` };
    r.commit();
    const paid = { ...base, paid: price, asked: price, txHash: `0x${s.id}` };
    switch (s.id) {
      case "city-info":
        return { ...paid, status: "paid", ok: true, data: { city: input.name, country: "Japan", country_code: "JP", currency: "JPY", timezone: "Asia/Tokyo", temperature_c: 21, wind_kmh: 9, conditions: "clear sky", observed_at: "now" } };
      case "fx-rates":
        return { ...paid, status: "paid", ok: true, data: { from: input.from, to: input.to, rate: 190, date: "2026-01-01" } };
      case "junk-fx":
        return { ...paid, status: "paid_output_rejected", ok: false, reason: "output breaks listed schema" };
      case "hindi-summary":
        return { ...paid, status: "paid", ok: true, data: { language: "hi", summaries: input.texts.map((t: string) => ({ summary: `हिंदी ${t}` })) } };
    }
    throw new Error(`the chain hired ${s.id}, which it must not`);
  };
  return { pay, calls };
}

const chainOf = (plan: ReturnType<typeof planChain>, subBudget = 13000n, serviceId = "my-chain") => ({ serviceId, owner: "0xowner", steps: plan.steps, subBudget });
const deps = (pay: ReturnType<typeof fakePay>["pay"], over: Record<string, unknown> = {}) => ({ pay, address: "0xchain", balance: async () => 1_000_000n, services: () => listed(), ...over }) as any;

// ---- planning -------------------------------------------------------------------------------------------------------

describe("agent chain: planning and validation", () => {
  it("builds the chain's listing from its steps: buyer fields in, last step's output inside, last step's category", () => {
    const plan = planChain(travel(), "my-chain", lookupIn(listed()));
    expect(plan.inputSchema).toMatchObject({ type: "object", required: ["city", "currency"], additionalProperties: false });
    expect(Object.keys(plan.inputSchema.properties)).toEqual(["city", "currency"]);
    expect(plan.inputSchema.properties.city.description).toMatch(/City name/);
    expect(plan.outputSchema.properties.result).toEqual(summariseOutput);
    expect(plan.outputSchema.required).toEqual(["result", "steps", "hired", "cost_units"]);
    expect(plan.category).toBe("inference");
    expect(plan.cost).toBe(13000n);
    expect(plan.steps.every((s) => s.key.length > 0)).toBe(true);
  });

  it("refuses steps whose inputs cannot be filled correctly", () => {
    const lookup = lookupIn(listed());
    const bad: [unknown, RegExp][] = [
      [withStep(1, { serviceId: "fx-rates", input: { from: { from: "buyer", field: "currency" } } }), /required field "to"/],
      [withStep(0, { serviceId: "city-info", input: { name: { from: "step", step: 2, field: "to" } } }), /earlier step/],
      [withStep(1, { serviceId: "fx-rates", input: { from: { from: "buyer", field: "currency" }, to: { from: "step", step: 1, field: "money" } } }), /no output field "money"/],
      [withStep(1, { serviceId: "fx-rates", input: { from: { from: "buyer", field: "currency" }, to: { from: "step", step: 1, field: "temperature_c" } } }), /cannot fill/],
      [withStep(1, { serviceId: "fx-rates", input: { from: { from: "fixed", value: "pounds" }, to: { from: "step", step: 1, field: "currency" } } }), /fixed value for "from" is not valid/],
      [withStep(1, { serviceId: "fx-rates", input: { from: { from: "buyer", field: "city" }, to: { from: "step", step: 1, field: "currency" } } }), /two inputs of different types/],
      [withStep(0, { serviceId: "city-info", input: { name: { from: "buyer", field: "city" }, extra: { from: "fixed", value: 1 } } }), /no input field "extra"/],
      [withStep(0, { serviceId: "nope", input: {} }), /not listed/],
    ];
    for (const [form, why] of bad) expect(() => planChain(form as any, "my-chain", lookup), String(why)).toThrow(why);
  });

  it("only hires verified sellers, never itself, travel-brief or another chain", () => {
    expect(() => planChain(travel(), "my-chain", lookupIn(listed({ "city-info": { verification: "mismatch" } })))).toThrow(/not been verified/);
    expect(() => planChain(withStep(2, { serviceId: "travel-brief", input: { city: { from: "buyer", field: "city" } } }) as any, "my-chain", lookupIn(listed()))).toThrow(/chains cannot hire other chains/);
    upsertChain({ serviceId: "other-chain", owner: "0xabc", steps: [], subBudget: 1n });
    const list = [...listed(), { ...service({ id: "other-chain", verification: "verified" }), reputation: rep }];
    expect(() => planChain(withStep(2, { serviceId: "other-chain", input: {} }) as any, "my-chain", lookupIn(list))).toThrow(/chains cannot hire other chains/);
    expect(() => planChain(withStep(2, { serviceId: "other-chain", input: {} }) as any, "other-chain", lookupIn(list))).toThrow(/cannot hire itself/);
  });

  it("the sub-budget must cover today's prices and stay within the price", () => {
    const lookup = lookupIn(listed());
    expect(() => planChain(travel({ subBudget: "12999" }), "c", lookup)).toThrow(/must cover/);
    expect(() => planChain(travel({ subBudget: "20001" }), "c", lookup)).toThrow(/not be more than your price/);
    expect(planChain(travel({ subBudget: "20000" }), "c", lookup).cost).toBe(13000n);
  });

  it("knows which values can fill which fields", () => {
    expect(fit({ type: "string" }, { type: "string" })).toBe("ok");
    expect(fit({ type: "integer" }, { type: "number" })).toBe("ok");
    expect(fit({ type: ["integer", "null"] }, { type: "number" })).toBe("ok");
    expect(fit({ type: "string" }, { type: "array", items: { type: "string" } })).toBe("wrap");
    expect(fit({ type: "number" }, { type: "string" })).toBeNull();
    expect(fit({ type: "number" }, { type: "array", items: { type: "string" } })).toBeNull();
    expect(fit({}, { type: "string" })).toBe("ok");
  });
});

// ---- running --------------------------------------------------------------------------------------------------------

describe("agent chain: running", () => {
  const plan = () => planChain(travel(), "my-chain", lookupIn(listed()));

  it("hires each step in order with the mapped inputs, and its answer fits its own output schema", async () => {
    const p = fakePay();
    const out = await runChain(chainOf(plan()), { city: "Tokyo", currency: "GBP" }, deps(p.pay));
    expect(p.calls.map((c) => c.id)).toEqual(["city-info", "fx-rates", "hindi-summary"]);
    expect(p.calls[1].input).toEqual({ from: "GBP", to: "JPY" });
    expect(p.calls[2].input).toEqual({ texts: ["clear sky"] });
    expect(out.hired.map((h) => [h.service, h.tx_hash])).toEqual([["city-info", "0xcity-info"], ["fx-rates", "0xfx-rates"], ["hindi-summary", "0xhindi-summary"]]);
    expect(out.cost_units).toBe("13000");
    expect(validate(plan().outputSchema, out)).toEqual({ ok: true });
  });

  it("swaps a seller that returns junk for a verified one doing the same job", async () => {
    const form = withStep(1, { serviceId: "junk-fx", input: { from: { from: "buyer", field: "currency" }, to: { from: "step", step: 1, field: "currency" } } });
    const pl = planChain(form as any, "my-chain", lookupIn(listed()));
    const p = fakePay();
    const out = await runChain(chainOf(pl, 20000n), { city: "Tokyo", currency: "GBP" }, deps(p.pay));
    expect(p.calls.map((c) => c.id)).toEqual(["city-info", "junk-fx", "fx-rates", "hindi-summary"]);
    expect(out.hired.find((h) => h.service === "junk-fx")?.status).toBe("paid_output_rejected");
  });

  it("stops before overspending its sub-budget and fails so the buyer is not charged", async () => {
    const p = fakePay();
    const run = runChain(chainOf(plan(), 3000n), { city: "Tokyo", currency: "GBP" }, deps(p.pay));
    await expect(run).rejects.toBeInstanceOf(ServiceError);
    await expect(run).rejects.toThrow(/step 3 failed/);
    expect(p.calls.map((c) => c.id)).toEqual(["city-info", "fx-rates", "hindi-summary"]);
  });

  it("refuses to start without enough float, or when no seller for a step is listed", async () => {
    const p = fakePay();
    await expect(runChain(chainOf(plan()), { city: "Tokyo", currency: "GBP" }, deps(p.pay, { balance: async () => 12999n }))).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/out of float/) });
    await expect(runChain(chainOf(plan()), { city: "Tokyo", currency: "GBP" }, deps(p.pay, { services: () => listed().filter((s) => s.id !== "city-info") }))).rejects.toMatchObject({ status: 503 });
    expect(p.calls).toEqual([]);
  });

  it(`handles at most ${MAX_CONCURRENT} requests at once`, async () => {
    let release!: () => void;
    const p = fakePay(new Promise<void>((r) => (release = r)));
    const running = Array.from({ length: MAX_CONCURRENT }, () => runChain(chainOf(plan()), { city: "Tokyo", currency: "GBP" }, deps(p.pay)));
    await expect(runChain(chainOf(plan()), { city: "Tokyo", currency: "GBP" }, deps(p.pay))).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/already handling/) });
    release();
    await Promise.all(running);
    await expect(runChain(chainOf(plan()), { city: "Tokyo", currency: "GBP" }, deps(fakePay().pay))).resolves.toBeDefined();
  });
});

// ---- Sell-tab routes and the paid route -----------------------------------------------------------------------------

const ORIGIN = "http://localhost:3000";
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());

async function loginCookie(account: typeof alice) {
  const { nonce } = (await (await auth.request("/nonce")).json()) as { nonce: string };
  const message = loginMessage({ address: account.address, nonce, issuedAt: new Date().toISOString(), uri: ORIGIN });
  const res = await auth.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

const send = (method: string, path: string, cookie?: string, body?: unknown) =>
  registry.request(path, { method, headers: { ...(cookie ? { cookie } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const form = (over: Record<string, unknown> = {}) => ({ name: "tokyo-brief", description: "Weather, your money in the local currency, and a Hindi line.", ...travel(), ...over });

const { app: sellersApp } = buildSellers();
const server = new Hono().route("/sellers", sellersApp);
const run = (id: string, body: unknown, nonce?: string) =>
  server.request(`/sellers/c/${id}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(nonce
        ? {
            "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
              x402Version: 2,
              accepted: accept(),
              payload: { signature: "0x00", authorization: { from: "0x" + "99".repeat(20), to: SELLER, value: "20000", validAfter: "0", validBefore: "9999999999", nonce } },
            } as any),
          }
        : {}),
    },
    body: JSON.stringify(body),
  });

let aliceCookie: string;
let bobCookie: string;

describe("agent chain: Sell tab and paid route", () => {
  beforeEach(async () => {
    config.secretsKey = "ab".repeat(32);
    db.exec("DELETE FROM services; DELETE FROM chain_sellers; DELETE FROM sessions; DELETE FROM auth_nonces; DELETE FROM nonces; DELETE FROM sales");
    fake.settleCalls = 0;
    fake.balance = 0n;
    // The three sellers the chain hires, listed and verified like the built-ins are at boot.
    for (const d of sellerDefs().filter((d) => ["city-info", "fx-rates", "hindi-summary"].includes(d.id))) {
      upsertService({ id: d.id, name: d.name, category: d.category, endpoint: `http://127.0.0.1:4021/sellers/${d.id}${d.path}`, method: d.method, price: d.listedPrice.toString(), network: NETWORK, asset: accept().asset as string, payTo: SELLER, inputSchema: d.inputSchema, outputSchema: d.outputSchema, description: d.description, owner: "gandiva" });
      setVerification(d.id, { verification: "verified", note: "test" });
    }
    // The registry probes the new listing over loopback: send that to the seller app in-process.
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: any, init: any = {}) => server.request(new URL(String(input)).pathname, init)) as any);
    aliceCookie = await loginCookie(alice);
    bobCookie = await loginCookie(bob);
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists a chain that pays the owner's agent wallet and passes the registry's own 402 probe", async () => {
    const res = await send("POST", "/mine/chains", aliceCookie, form());
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    const agentWallet = ensureAgentWallet(alice.address);
    expect(body).toMatchObject({ id: "tokyo-brief", category: "inference", method: "POST", price: "20000", payTo: agentWallet, owner: `wallet:${alice.address.toLowerCase()}`, verification: "verified" });
    expect(body.endpoint).toBe(`${config.publicBaseUrl}/sellers/c/tokyo-brief/run`);
    expect(getChain("tokyo-brief")).toMatchObject({ owner: alice.address.toLowerCase(), subBudget: 13000n });

    const mine = (await (await send("GET", "/mine", aliceCookie)).json()) as any;
    expect(mine.chains["tokyo-brief"]).toMatchObject({ subBudget: "13000", hires: ["city-info", "fx-rates", "hindi-summary"] });
    const all = (await (await send("GET", "/services")).json()) as any;
    expect(all.services.find((s: any) => s.id === "tokyo-brief").chain).toEqual({ hires: ["city-info", "fx-rates", "hindi-summary"] });
    expect(all.services.find((s: any) => s.id === "city-info").chain).toBeNull();
  });

  it("needs a sign-in, a SECRETS_KEY and 2 to 3 steps", async () => {
    expect((await send("POST", "/mine/chains", undefined, form())).status).toBe(401);
    expect((await send("POST", "/mine/chains", aliceCookie, form({ steps: travel().steps.slice(0, 1) }))).status).toBe(400);
    expect((await send("POST", "/mine/chains", aliceCookie, form({ steps: [...travel().steps, travel().steps[2]] }))).status).toBe(400);
    expect((await send("POST", "/mine/chains", aliceCookie, form({ description: "short" }))).status).toBe(400);
    config.secretsKey = "";
    const res = await send("POST", "/mine/chains", aliceCookie, form());
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toMatch(/SECRETS_KEY/);
    expect(getService("tokyo-brief")).toBeUndefined();
  });

  it("another wallet cannot take or delete it; the owner's delete removes the steps; the endpoint form cannot overwrite it", async () => {
    await send("POST", "/mine/chains", aliceCookie, form());
    expect((await send("POST", "/mine/chains", bobCookie, form())).status).toBe(409);
    expect((await send("DELETE", "/mine/services/tokyo-brief", bobCookie)).status).toBe(403);
    expect((await send("POST", "/mine/services", aliceCookie, { name: "tokyo-brief", category: "data", endpoint: "https://seller.example/x", price: "1500", inputSchema: { type: "object" }, outputSchema: { type: "object" } })).status).toBe(409);
    expect((await send("DELETE", "/mine/services/tokyo-brief", aliceCookie)).status).toBe(200);
    expect(getChain("tokyo-brief")).toBeUndefined();
    expect((await run("tokyo-brief", { city: "Tokyo", currency: "GBP" })).status).toBe(404);
  });

  it("quotes cost, margin and whether the agent wallet can pay, for free", async () => {
    fake.balance = 50_000n;
    const res = await send("POST", "/mine/chains/quote", aliceCookie, travel());
    expect(res.status).toBe(200);
    const q = (await res.json()) as any;
    expect(q).toMatchObject({ cost: "13000", subBudget: "13000", price: "20000", margin: "7000", category: "inference", agentWallet: { address: ensureAgentWallet(alice.address), balance: "50000", enough: true } });
    expect(q.steps.map((s: any) => s.serviceId)).toEqual(["city-info", "fx-rates", "hindi-summary"]);
    expect((await send("POST", "/mine/chains/quote", aliceCookie, travel({ subBudget: "1" }))).status).toBe(400);
  });

  it("the paid route asks for the listed price to the agent wallet, and charges nothing when the chain is out of float", async () => {
    await send("POST", "/mine/chains", aliceCookie, form());
    const challenge = await run("tokyo-brief", { city: "Tokyo", currency: "GBP" });
    expect(challenge.status).toBe(402);
    expect(((await challenge.json()) as any).accepts[0]).toMatchObject({ payTo: ensureAgentWallet(alice.address), amount: "20000" });

    fake.balance = 0n;
    const paid = await run("tokyo-brief", { city: "Tokyo", currency: "GBP" }, "0x" + "01".repeat(32));
    expect(paid.status).toBe(503);
    expect(((await paid.json()) as any).error).toMatch(/out of float/);
    expect(fake.settleCalls).toBe(0);
  });

  it("the paid test run reports a chain that cannot pay, without listing anything", async () => {
    fake.balance = 0n;
    const res = await send("POST", "/mine/chains/test", aliceCookie, { ...travel(), input: { city: "Tokyo", currency: "GBP" } });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toMatch(/out of float/);
    expect((await send("POST", "/mine/chains/test", aliceCookie, { ...travel(), input: { city: "Tokyo" } })).status).toBe(400);
    expect(getService("tokyo-brief")).toBeUndefined();
  });
});

// ChainError is part of the module's API (the routes map it to HTTP statuses).
it("ChainError carries an HTTP status", () => expect(new ChainError("x", 409).status).toBe(409));
