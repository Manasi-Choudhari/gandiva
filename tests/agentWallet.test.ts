import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loginMessage } from "../src/auth/session.js";
import { config, NETWORK, USDC_ADDRESS } from "../src/config.js";
import { db } from "../src/db.js";
import { addLedger } from "../src/registry/store.js";
import { SpendCap } from "../src/x402/spendCap.js";

const chain = vi.hoisted(() => ({ balance: 0n, readCalls: 0, fail: false }));
const scout = vi.hoisted(() => ({ startTask: vi.fn(), active: false }));

vi.mock("../src/x402/chain.js", () => ({
  chainClient: () => ({
    readContract: async () => {
      chain.readCalls++;
      if (chain.fail) throw new Error("rpc down");
      return chain.balance;
    },
  }),
}));
vi.mock("../src/buyer/scout.js", () => ({
  startTask: scout.startTask,
  buyCategory: vi.fn(),
  buyOnce: vi.fn(),
  getRun: vi.fn(),
  listRuns: () => [],
  getPayer: () => ({ address: "0x" + "dd".repeat(20) }),
  hasActiveRun: () => scout.active,
}));

const { auth } = await import("../src/auth/routes.js");
const { agent } = await import("../src/agents/routes.js");
const { buyer } = await import("../src/buyer/routes.js");
const { registry } = await import("../src/registry/routes.js");
const wallet = await import("../src/agents/wallet.js");

const ORIGIN = "http://localhost:3000";
const KEY = "ab".repeat(32);
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
const json = (cookie?: string, body?: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body ?? {}) });

let aliceCookie: string;
let bobCookie: string;

beforeEach(async () => {
  config.secretsKey = KEY;
  config.buyerToken = "";
  chain.balance = 0n;
  chain.readCalls = 0;
  chain.fail = false;
  scout.startTask.mockReset();
  scout.startTask.mockReturnValue({ id: "run12345" });
  scout.active = false;
  db.exec("DELETE FROM users; DELETE FROM sessions; DELETE FROM auth_nonces; DELETE FROM withdrawals; DELETE FROM ledger");
  aliceCookie = await loginCookie(alice);
  bobCookie = await loginCookie(bob);
});

describe("agent wallet: one server-made wallet per user", () => {
  it("is created on first use, is stable, and the key is stored encrypted", () => {
    const a = wallet.ensureAgentWallet(alice.address);
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(wallet.ensureAgentWallet(alice.address)).toBe(a);
    expect(wallet.ensureAgentWallet(alice.address.toLowerCase())).toBe(a);
    expect(wallet.ensureAgentWallet(bob.address)).not.toBe(a);
    const row = db.prepare("SELECT agent_key_enc FROM users WHERE address = ?").get(alice.address.toLowerCase()) as { agent_key_enc: string };
    expect(row.agent_key_enc).toMatch(/^v1:/);
    expect(row.agent_key_enc).not.toMatch(/0x[0-9a-f]{64}/);
  });

  it("the payer signs with exactly that wallet", () => {
    const payer = wallet.getAgentPayer(alice.address);
    expect(payer.address).toBe(wallet.ensureAgentWallet(alice.address));
    expect(wallet.getAgentPayer(alice.address)).toBe(payer);
  });

  it("refuses to make wallets without a SECRETS_KEY", () => {
    config.secretsKey = "";
    expect(() => wallet.ensureAgentWallet(bob.address)).toThrow(/SECRETS_KEY/);
  });
});

describe("spend cap per wallet", () => {
  const row = (buyerAddr: string, paid: string) => addLedger({ buyer: buyerAddr, seller: "0xs", serviceName: "svc", endpoint: "http://x", listed: paid, asked: paid, paid, status: "paid", latencyMs: 1 });

  it("a wallet's cap counts only its own payments", () => {
    row("0xAAAA", "300000");
    row("0xbbbb", "100000");
    expect(new SpendCap(500_000n, 3_600_000, "0xaaaa").used()).toBe(300_000n);
    expect(new SpendCap(500_000n, 3_600_000, "0xBBBB").used()).toBe(100_000n);
    expect(new SpendCap(500_000n, 3_600_000).used()).toBe(400_000n); // no buyer = every row, as before
  });

  it("each user's payer has its own cap that ignores other users' spending", async () => {
    const a = wallet.getAgentPayer(alice.address);
    const b = wallet.getAgentPayer(bob.address);
    row(a.address, "450000");
    expect(a.cap.used()).toBe(450_000n);
    expect(b.cap.used()).toBe(0n);
    expect(await a.cap.reserve(100_000n)).toBeNull();
    expect(await b.cap.reserve(100_000n)).not.toBeNull();
  });
});

describe("agent wallet routes", () => {
  it("need a sign-in", async () => {
    expect((await agent.request("/")).status).toBe(401);
    expect((await agent.request("/withdraw", json())).status).toBe(401);
  });

  it("show the address, the on-chain balance and the spend cap", async () => {
    chain.balance = 1_250_000n;
    const res = await agent.request("/", { headers: { cookie: aliceCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.address).toBe(wallet.ensureAgentWallet(alice.address));
    expect(body).toMatchObject({ balance: "1250000", balanceUsdc: "1.250000", network: NETWORK, asset: USDC_ADDRESS, user: alice.address.toLowerCase() });
    expect(body.spendCap.limit).toBe("500000");
    expect(JSON.stringify(body)).not.toMatch(/agent_key/);
  });

  it("two users see different wallets", async () => {
    const a = (await (await agent.request("/", { headers: { cookie: aliceCookie } })).json()) as any;
    const b = (await (await agent.request("/", { headers: { cookie: bobCookie } })).json()) as any;
    expect(a.address).not.toBe(b.address);
  });

  it("a failing balance read does not break the panel", async () => {
    chain.fail = true;
    const res = await agent.request("/", { headers: { cookie: aliceCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.balance).toBeNull();
    expect(body.balanceError).toMatch(/could not read the balance/);
    expect(body.address).toMatch(/^0x/);
  });

  it("withdraw validates the amount and waits for a running run", async () => {
    expect((await agent.request("/withdraw", json(aliceCookie, { amount: "1.5" }))).status).toBe(400);
    expect((await agent.request("/withdraw", json(aliceCookie, { amount: "-3" }))).status).toBe(400);
    scout.active = true;
    const res = await agent.request("/withdraw", json(aliceCookie, { amount: "all" }));
    expect(res.status).toBe(409);
  });

  it("withdraw with an empty wallet says so and moves nothing", async () => {
    const res = await agent.request("/withdraw", json(aliceCookie, { amount: "all" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/no USDC/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM withdrawals").get()).toEqual({ n: 0 });
  });
});

describe("withdraw: gasless transfer back to the owner", () => {
  const ok = (tx = "0x" + "ab".repeat(32)) => ({ settle: vi.fn(async () => ({ success: true, transaction: tx, network: NETWORK, payer: "0x" })) });

  it("can withdraw more than the x402 library's default $1-per-payment cap", async () => {
    const settler = ok();
    const w = await wallet.withdraw(alice.address, 1_500_000n, { settler: settler as any, balance: async () => 25_000_000n });
    expect(w).toMatchObject({ status: "settled", amount: "1500000" });
    const all = await wallet.withdraw(alice.address, "all", { settler: settler as any, balance: async () => 25_000_000n });
    expect(all).toMatchObject({ status: "settled", amount: "25000000" });
  });

  it("signs an exact payment from the agent wallet to the owner and records it", async () => {
    const settler = ok();
    const w = await wallet.withdraw(alice.address, 400_000n, { settler: settler as any, balance: async () => 1_000_000n });
    expect(w).toMatchObject({ status: "settled", amount: "400000", to_address: alice.address.toLowerCase(), agent_address: wallet.ensureAgentWallet(alice.address), tx_hash: "0x" + "ab".repeat(32) });
    const [payload, requirements] = settler.settle.mock.calls[0] as any[];
    expect(requirements).toMatchObject({ scheme: "exact", network: NETWORK, asset: USDC_ADDRESS, amount: "400000", payTo: alice.address.toLowerCase() });
    const auth = payload.payload.authorization;
    expect(auth.from.toLowerCase()).toBe(wallet.ensureAgentWallet(alice.address).toLowerCase());
    expect(auth.to.toLowerCase()).toBe(alice.address.toLowerCase());
    expect(auth.value).toBe("400000");
  });

  it("'all' sends the whole balance; more than the balance is refused before anything is signed", async () => {
    const settler = ok();
    const all = await wallet.withdraw(bob.address, "all", { settler: settler as any, balance: async () => 777_000n });
    expect(all.amount).toBe("777000");
    const refused = wallet.withdraw(bob.address, 2_000_000n, { settler: settler as any, balance: async () => 777_000n });
    await expect(refused).rejects.toThrow(/less than/);
    expect(settler.settle).toHaveBeenCalledTimes(1);
  });

  it("a settlement the facilitator rejects is recorded as failed and is not counted as money out", async () => {
    const settler = { settle: vi.fn(async () => ({ success: false, errorReason: "insufficient_funds", transaction: "", network: NETWORK })) };
    await expect(wallet.withdraw(alice.address, 1000n, { settler: settler as any, balance: async () => 5000n })).rejects.toThrow(/Nothing was moved/);
    expect(wallet.listWithdrawals(wallet.ensureAgentWallet(alice.address)).map((w) => w.status)).toEqual(["failed"]);
  });

  it("a request that dies after signing is recorded as unknown, never as settled", async () => {
    const settler = { settle: vi.fn(async () => Promise.reject(new Error("socket hang up"))) };
    await expect(wallet.withdraw(alice.address, 1000n, { settler: settler as any, balance: async () => 5000n })).rejects.toThrow(/could not confirm/);
    expect(wallet.listWithdrawals(wallet.ensureAgentWallet(alice.address)).map((w) => w.status)).toEqual(["unknown"]);
  });

  it("the public withdrawals list can be filtered by wallet (reconcile needs it)", async () => {
    await wallet.withdraw(alice.address, 1000n, { settler: ok() as any, balance: async () => 5000n });
    await wallet.withdraw(bob.address, 2000n, { settler: ok() as any, balance: async () => 5000n });
    const all = (await (await registry.request("/withdrawals")).json()) as any;
    expect(all.withdrawals).toHaveLength(2);
    const mine = (await (await registry.request(`/withdrawals?buyer=${wallet.ensureAgentWallet(alice.address)}`)).json()) as any;
    expect(mine.withdrawals.map((w: any) => w.amount)).toEqual(["1000"]);
  });
});

describe("runs pay from the signed-in user's agent wallet", () => {
  const run = (cookie: string | undefined, body: Record<string, unknown> = {}) => buyer.request("/run", json(cookie, { task: "do a thing", budget: "0.05", ...body }));

  it("anonymous visitors still use the shared demo wallet", async () => {
    const res = await run(undefined);
    expect(res.status).toBe(202);
    const opts = scout.startTask.mock.calls[0][0];
    expect(opts.payer).toBeUndefined();
    expect(opts.owner).toBeUndefined();
    expect(chain.readCalls).toBe(0);
  });

  it("a signed-in user pays with their own wallet when it holds the budget", async () => {
    chain.balance = 60_000n;
    const res = await run(aliceCookie);
    expect(res.status).toBe(202);
    const opts = scout.startTask.mock.calls[0][0];
    expect(opts.payer.address).toBe(wallet.ensureAgentWallet(alice.address));
    expect(opts.owner).toBe(alice.address.toLowerCase());
  });

  it("refuses a run the agent wallet cannot afford and explains how much it holds", async () => {
    chain.balance = 20_000n;
    const res = await run(aliceCookie);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/holds 0\.020000 USDC but this run's budget is 0\.05/);
    expect(scout.startTask).not.toHaveBeenCalled();
  });

  it("a dry run needs no funds", async () => {
    chain.balance = 0n;
    expect((await run(aliceCookie, { dryRun: true })).status).toBe(202);
    expect(scout.startTask.mock.calls[0][0].dryRun).toBe(true);
  });

  it("the optional buyer token guards the shared wallet only, not a signed-in user's own money", async () => {
    config.buyerToken = "secret-token";
    expect((await run(undefined)).status).toBe(401);
    chain.balance = 100_000n;
    expect((await run(aliceCookie)).status).toBe(202);
  });
});

describe("ledger by wallet", () => {
  it("can be filtered to one buyer", async () => {
    addLedger({ buyer: "0xAAA1", seller: "0xs", serviceName: "a", endpoint: "http://x", listed: "1", paid: "1", status: "paid", latencyMs: 1 });
    addLedger({ buyer: "0xBBB2", seller: "0xs", serviceName: "b", endpoint: "http://x", listed: "1", paid: "1", status: "paid", latencyMs: 1 });
    const res = (await (await registry.request("/ledger?buyer=0xaaa1")).json()) as any;
    expect(res.entries.map((e: any) => e.service_name)).toEqual(["a"]);
    expect(((await (await registry.request("/ledger")).json()) as any).entries).toHaveLength(2);
  });
});

describe("buyer token: signing in never unlocks the shared wallet", () => {
  it("/buy and /call still need the token, signed in or not", async () => {
    config.buyerToken = "secret-token";
    for (const path of ["/buy", "/call"]) {
      expect((await buyer.request(path, json(aliceCookie, { category: "data", serviceId: "x" }))).status, path).toBe(401);
      expect((await buyer.request(path, json(undefined, { category: "data", serviceId: "x" }))).status, path).toBe(401);
    }
  });
});

describe("withdrawals of unknown outcome", () => {
  const dies = () => ({ settle: vi.fn(async () => Promise.reject(new Error("socket hang up"))) });
  const unknownRow = async () => {
    await expect(wallet.withdraw(alice.address, 1000n, { settler: dies() as any, balance: async () => 5000n })).rejects.toThrow(/could not confirm/);
    return db.prepare("SELECT * FROM withdrawals ORDER BY id DESC LIMIT 1").get() as any;
  };

  it("keep the signed authorisation so the chain can settle them later", async () => {
    const w = await unknownRow();
    expect(w.status).toBe("unknown");
    expect(w.auth_nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.valid_before).toBeGreaterThan(Date.now() / 1000);
  });

  it("become settled when the authorisation was used on chain", async () => {
    const w = await unknownRow();
    const lookup = vi.fn(async (_a: { from: string; nonce: string }) => ({ state: "used" as const, txHash: "0x" + "ef".repeat(32), amount: 1000n, to: alice.address }));
    expect(await wallet.resolveUnknownWithdrawals(lookup)).toBe(1);
    expect(lookup.mock.calls[0][0]).toMatchObject({ from: w.agent_address, nonce: w.auth_nonce });
    expect(db.prepare("SELECT status, tx_hash FROM withdrawals WHERE id = ?").get(w.id)).toEqual({ status: "settled", tx_hash: "0x" + "ef".repeat(32) });
  });

  it("become failed once the authorisation expired unused, and stay unknown while it can still be used", async () => {
    const w = await unknownRow();
    expect(await wallet.resolveUnknownWithdrawals(async () => ({ state: "unused", expired: false }))).toBe(0);
    expect((db.prepare("SELECT status FROM withdrawals WHERE id = ?").get(w.id) as any).status).toBe("unknown");
    expect(await wallet.resolveUnknownWithdrawals(async () => ({ state: "unused", expired: true }))).toBe(1);
    expect((db.prepare("SELECT status FROM withdrawals WHERE id = ?").get(w.id) as any).status).toBe("failed");
  });

  it("a signing error is recorded as failed (nothing left the server), not unknown", async () => {
    const payer = wallet.getAgentPayer(alice.address);
    vi.spyOn(payer, "signWithdrawal").mockRejectedValueOnce(new Error("bad key"));
    const settler = dies();
    await expect(wallet.withdraw(alice.address, 1000n, { settler: settler as any, balance: async () => 5000n })).rejects.toThrow(/Nothing was moved/);
    expect(settler.settle).not.toHaveBeenCalled();
    expect(wallet.listWithdrawals(payer.address).map((w) => w.status)).toEqual(["failed"]);
  });
});
