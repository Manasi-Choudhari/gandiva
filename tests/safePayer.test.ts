import { encodePaymentResponseHeader } from "@x402/core/http";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK } from "../src/config.js";
import { db } from "../src/db.js";
import { SafePayer } from "../src/x402/safePayer.js";
import { BudgetLedger } from "../src/x402/budget.js";
import { accept, challenge402, service } from "./helpers.js";

// The key is generated per run, so no secret ever lives in the repo.
const payer = new SafePayer(generatePrivateKey());
const row = (id: number) => db.prepare("SELECT * FROM ledger WHERE id = ?").get(id) as any;
const TX = "0x" + "cd".repeat(32);

/** First request gets the 402 challenge; the second (signed) request is whatever the test wants. */
function stubSeller(second: () => Response | Promise<Response>) {
  let n = 0;
  const fetchMock = vi.fn(async () => (n++ === 0 ? challenge402() : second()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const settled = () => ({ "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: TX, network: NETWORK, payer: payer.address } as any) });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

beforeEach(() => {
  db.exec("DELETE FROM ledger");
});
afterEach(() => vi.unstubAllGlobals());

describe("SafePayer: outcomes after the payment is signed", () => {
  it("clean success is recorded as paid, with the tx hash", async () => {
    stubSeller(() => json({ rate: 105.2 }, 200, settled()));
    const budget = new BudgetLedger(10_000n);
    const r = await payer.call(service(), {}, { budget });
    expect(r).toMatchObject({ status: "paid", ok: true, paid: 1000n, txHash: TX });
    expect(budget.spent).toBe(1000n);
  });

  it("a timeout after signing is UNCONFIRMED, not 'not charged', and the budget stays spent", async () => {
    stubSeller(() => {
      throw new Error("The operation was aborted due to timeout");
    });
    const budget = new BudgetLedger(10_000n);
    const r = await payer.call(service(), {}, { budget });
    expect(r.status).toBe("unconfirmed");
    expect(r.ok).toBe(false);
    expect(budget.spent).toBe(1000n);
    expect(budget.reserved).toBe(0n);
    const saved = row(r.ledgerId);
    expect(saved).toMatchObject({ status: "unconfirmed", paid: "0", asked: "1000" });
    expect(saved.auth_from.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(saved.auth_nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(saved.valid_before).toBeGreaterThan(Date.now() / 1000);
  });

  it("a 200 without a PAYMENT-RESPONSE is unconfirmed, never 'paid' without proof", async () => {
    stubSeller(() => json({ rate: 105.2 }));
    const r = await payer.call(service(), {}, { budget: new BudgetLedger(10_000n) });
    expect(r.status).toBe("unconfirmed");
    expect(r.txHash).toBeUndefined();
    expect(row(r.ledgerId).auth_nonce).toBeTruthy();
  });

  it("a settled payment with schema-breaking output is 'paid, output rejected'", async () => {
    stubSeller(() => json({ rate: "high" }, 200, settled()));
    const r = await payer.call(service(), {}, { budget: new BudgetLedger(10_000n) });
    expect(r).toMatchObject({ status: "paid_output_rejected", paid: 1000n, txHash: TX });
  });

  it("an explicit seller error without settlement is 'failed, not charged', and the budget stays held", async () => {
    stubSeller(() => json({ error: "service failed, not charged", charged: false }, 502));
    const budget = new BudgetLedger(10_000n);
    const r = await payer.call(service(), {}, { budget });
    expect(r).toMatchObject({ status: "failed_not_charged", paid: 0n });
    expect(budget.spent).toBe(0n);
    expect(budget.remaining).toBe(9_000n); // the seller still holds a live signature
    // the authorisation is kept so the resolver can double-check the chain until it expires
    expect(row(r.ledgerId).auth_nonce).toBeTruthy();
  });

  it("a seller claiming failure while it keeps the signature cannot push a run past its budget", async () => {
    let signed = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: any) => (init?.headers?.["PAYMENT-SIGNATURE"] ? (signed++, json({ error: "sorry", charged: false }, 500)) : challenge402())));
    const budget = new BudgetLedger(3_000n);
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await payer.call(service(), {}, { budget }));
    expect(signed).toBe(3);
    expect(results.at(-1)!.reason).toMatch(/^budget:/);
  });

  it("a seller that settles but then errors is charged (paid, output rejected)", async () => {
    stubSeller(() => json({ error: "boom" }, 500, settled()));
    const r = await payer.call(service(), {}, { budget: new BudgetLedger(10_000n) });
    expect(r).toMatchObject({ status: "paid_output_rejected", paid: 1000n, txHash: TX });
  });
});

describe("SafePayer: nothing is signed when the terms are wrong", () => {
  it("refuses a 402 asking more than listed, sends no second request, writes no authorisation", async () => {
    const fetchMock = vi.fn(async () => challenge402(accept({ amount: "10000" })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await payer.call(service(), {}, { budget: new BudgetLedger(100_000n) });
    expect(r).toMatchObject({ status: "refused", paid: 0n });
    expect(r.reason).toMatch(/price check/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(row(r.ledgerId).auth_nonce).toBeNull();
  });

  it("refuses when the budget cannot cover the price", async () => {
    const fetchMock = vi.fn(async () => challenge402());
    vi.stubGlobal("fetch", fetchMock);
    const r = await payer.call(service(), {}, { budget: new BudgetLedger(500n) });
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/^budget:/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an unreachable seller is a plain not-charged failure (nothing was signed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    const r = await payer.call(service(), {}, { budget: new BudgetLedger(10_000n) });
    expect(r.status).toBe("failed_not_charged");
    expect(row(r.ledgerId).auth_nonce).toBeNull();
  });
});

describe("SafePayer: parallel calls respect the run budget", () => {
  it("20 parallel calls on a 0.005 budget settle at most 5", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: any) => {
        await new Promise((r) => setTimeout(r, 5));
        return init?.headers?.["PAYMENT-SIGNATURE"] ? json({ rate: 1 }, 200, settled()) : challenge402();
      }),
    );
    const budget = new BudgetLedger(5_000n);
    const results = await Promise.all(Array.from({ length: 20 }, () => payer.call(service(), {}, { budget })));
    expect(results.filter((r) => r.status === "paid")).toHaveLength(5);
    expect(results.filter((r) => r.status === "refused")).toHaveLength(15);
    expect(budget.spent).toBe(5_000n);
  });
});

describe("SafePayer: hostile sellers before anything is signed", () => {
  it.each([
    ["a non-integer amount", { amount: "1.5" }],
    ["a missing payTo", { payTo: undefined }],
    ["a missing asset", { asset: undefined }],
  ])("a 402 with %s is refused, not a crash", async (_, over) => {
    vi.stubGlobal("fetch", vi.fn(async () => challenge402(accept(over))));
    const r = await payer.call(service(), {}, { budget: new BudgetLedger(10_000n) });
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/price check/);
    expect(row(r.ledgerId).status).toBe("refused");
  });

  it.each([
    ["Permit2", { extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } }],
    ["a made-up method", { extra: { assetTransferMethod: "anything" } }],
  ])("a 402 asking for %s instead of EIP-3009 is refused before anything is signed", async (_, over) => {
    const fetchMock = vi.fn(async () => challenge402(accept(over)));
    vi.stubGlobal("fetch", fetchMock);
    const r = await payer.call(service(), {}, { budget: new BudgetLedger(10_000n) });
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/is not eip3009/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a listing in any token but USDC is refused, because budgets count USDC", async () => {
    const other = "0x000000000000000000000000000000000000dEaD";
    const fetchMock = vi.fn(async () => challenge402(accept({ asset: other })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await payer.call(service({ asset: other }), {}, { budget: new BudgetLedger(10_000n) });
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/is not USDC/);
  });

  it("drops the seller's extensions, so it cannot ask the library to sign anything else", async () => {
    const seen: any[] = [];
    const spy = vi.spyOn((payer as any).client, "createPaymentPayload").mockImplementation(async (pr: any) => (seen.push(pr), Promise.reject(new Error("stop here"))));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ x402Version: 2, accepts: [accept()], extensions: { eip2612GasSponsoring: {} } }), { status: 402 })));
    await payer.call(service(), {}, { budget: new BudgetLedger(10_000n) });
    spy.mockRestore();
    expect(seen[0].extensions).toBeUndefined();
  });

  it("a 402 whose accepts is not a list is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ x402Version: 2, accepts: { amount: "1000" } }, 402)));
    const r = await payer.call(service(), {}, { budget: new BudgetLedger(10_000n) });
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/not a list/);
  });

  it("never follows a redirect (it could point at an internal address)", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await payer.call(service(), {}, { budget: new BudgetLedger(10_000n) });
    expect(r.status).toBe("failed_not_charged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an endpoint that now points at a private address, without calling it", async () => {
    const { config } = await import("../src/config.js");
    const before = process.env.ALLOW_PRIVATE_ENDPOINTS;
    process.env.ALLOW_PRIVATE_ENDPOINTS = "false";
    try {
      expect(config.allowPrivateEndpoints).toBe(false);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const r = await payer.call(service({ endpoint: "http://169.254.169.254/latest" }), {}, { budget: new BudgetLedger(10_000n) });
      expect(r.status).toBe("refused");
      expect(r.reason).toMatch(/endpoint guard: .*private/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) delete process.env.ALLOW_PRIVATE_ENDPOINTS;
      else process.env.ALLOW_PRIVATE_ENDPOINTS = before;
    }
  });
});
