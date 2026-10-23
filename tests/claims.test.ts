import { keccak256, toBytes, toHex, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// SellerStakeV2 as the claim worker sees it: claim state per id, the relayed sends, the verifier set.
const chain = vi.hoisted(() => ({
  claims: new Map<string, { status: number; executeAfter: number; amount: bigint }>(),
  bond: 1_000_000n as bigint | Error,
  clock: 0,
  failPropose: 0,
  proposedBy: [] as string[],
  view: {} as { signer?: Hex },
}));
const V_KEYS = vi.hoisted(() => ["verifier-1", "verifier-2", "verifier-3"]);

vi.mock("../src/stake/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/stake/index.js")>();
  const { claimIdOf, claimSignerOf } = await import("../src/stake/verify.js");
  const { fakeChain } = await import("./stakeFixtures.js");
  const { config } = await import("../src/config.js");
  const set = V_KEYS.map((l) => privateKeyToAccount(keccak256(toHex(l))).address);
  const tx = "0x" + "11".repeat(32);
  return {
    ...real,
    stakeEnabled: () => true,
    verifierSet: async () => set,
    chainView: () => fakeChain(chain.view),
    bondOnChain: async () => {
      if (chain.bond instanceof Error) throw chain.bond;
      return chain.bond;
    },
    stakeFees: async () => ({ stakeFee: 20_000n, slashFee: 20_000n }),
    slashedOnChain: async (id: string) => chain.claims.get(id)?.amount ?? null,
    claimOnChain: async (id: string) => chain.claims.get(id) ?? { status: 0, executeAfter: 0 },
    proposeOnChain: async (m: any, sigs: Hex[]) => {
      if (chain.failPropose-- > 0) throw new Error("rpc down");
      chain.proposedBy = await Promise.all(sigs.map((s) => claimSignerOf(m, s, config.stake.contract as Hex)));
      const id = claimIdOf(m.seller, m.buyer, m.paymentNonce);
      const executeAfter = Math.floor(chain.clock / 1000) + 1800;
      chain.claims.set(id, { status: 1, executeAfter, amount: m.amount });
      return { txHash: tx, id, executeAfter };
    },
    vetoOnChain: async (id: string) => (chain.claims.get(id)!.status = 3, { txHash: tx }),
    executeOnChain: async (id: string) => {
      const c = chain.claims.get(id)!;
      c.status = 2;
      return { txHash: tx, paid: c.amount };
    },
    relayerStatus: async () => ({ address: zeroAddress, eth: "1", low: false }),
    withdrawFor: async () => ({ ok: true }),
  };
});

import { runOnce } from "../scripts/verifier.js";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { addRebuttal, addSignature, fileClaim, listClaims, runClaims, slashedTotal } from "../src/stake/claims.js";
import { stakeRoutes } from "../src/stake/routes.js";
import { claimIdOf, signClaim, signVeto } from "../src/stake/verify.js";
import { BUYER, evidence, fakeChain, GOOD, PAID_AT, receiptFor, SELLER } from "./stakeFixtures.js";

const CONTRACT = "0x00000000000000000000000000000000000057a4" as Hex;
const KEY = V_KEYS.map((l) => keccak256(toHex(l)));
const ADDR = KEY.map((k) => privateKeyToAccount(k).address);
const T0 = Number(PAID_AT) * 1000 + 60_000;
const MIN = 60_000;

config.stake.contract = CONTRACT;
config.stake.verifierKey = KEY[0]; // this server is verifier 1

const run = (at: number) => runClaims((chain.clock = at));
const row = (ledgerId: number) => listClaims().find((c) => c.ledgerId === ledgerId)!;
const messageOf = (c: ReturnType<typeof row>) => ({ ...c.message, amount: BigInt(c.message.amount), deadline: BigInt(c.message.deadline) });
const sign = async (ledgerId: number, i: number) => addSignature(row(ledgerId).id, "claim", await signClaim(KEY[i], messageOf(row(ledgerId)), CONTRACT));

/** Files a claim for fresh evidence and runs the worker until it is open with the server's own signature. */
async function opened(o: Parameters<typeof evidence>[0]) {
  const e = await evidence(o);
  fileClaim({ ledgerId: e.ledgerId, evidence: e.hash, seller: SELLER, buyer: BUYER }, T0);
  await run(T0);
  await run(T0);
  return e;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  db.exec("DELETE FROM claims");
  chain.claims.clear();
  chain.bond = 1_000_000n;
  chain.failPropose = 0;
  chain.view = {};
});

describe("stake claim worker", () => {
  it("kind 1: server signs, an outsider is refused, a 2nd verifier signs, then propose, window, execute", async () => {
    const { ledgerId } = await opened({ n: 101 });
    expect(row(ledgerId)).toMatchObject({ state: "open", kind: 1, amount: "1000", signatures: [ADDR[0]] });

    const outsider = keccak256(toHex("outsider"));
    await expect(addSignature(row(ledgerId).id, "claim", await signClaim(outsider, messageOf(row(ledgerId)), CONTRACT))).rejects.toMatchObject({ status: 403 });
    expect(await sign(ledgerId, 1)).toEqual({ signer: ADDR[1], count: 2 });

    await run(T0 + 1000);
    expect(row(ledgerId).state).toBe("proposed");
    expect(chain.proposedBy).toEqual([ADDR[0], ADDR[1]].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)));
    await expect(addRebuttal(row(ledgerId).id, { receipt: "x", body: GOOD })).rejects.toMatchObject({ status: 409 }); // kind 1 rests on the seller's own receipt

    await run(T0 + 10 * MIN);
    expect(row(ledgerId).state).toBe("proposed"); // still inside the 30 min window
    await run(T0 + 31 * MIN);
    expect(row(ledgerId)).toMatchObject({ state: "executed", paid: "1000" });
    expect(slashedTotal(SELLER)).toEqual({ count: 1, amount: 1000n });
  });

  it("backs off after a failed propose and tries again later", async () => {
    const { ledgerId } = await opened({ n: 102 });
    await sign(ledgerId, 2);
    chain.failPropose = 1;
    await run(T0 + 1000);
    expect(row(ledgerId)).toMatchObject({ state: "open", attempts: 1, lastError: "rpc down" });
    await run(T0 + 30_000);
    expect(row(ledgerId).attempts).toBe(1); // not due yet (60 s backoff)
    await run(T0 + 1000 + 60_000);
    expect(row(ledgerId)).toMatchObject({ state: "proposed", attempts: 0 });
  });

  it("expires a claim that never got a 2nd signature before the deadline", async () => {
    const { ledgerId } = await opened({ n: 103 });
    await run(Number(PAID_AT + 3601n) * 1000);
    expect(row(ledgerId).state).toBe("expired");
  });

  it("closes a claim against a seller with no receipt signer as not_slashable", async () => {
    chain.view = { signer: zeroAddress };
    const e = await evidence({ n: 104 });
    fileClaim({ ledgerId: e.ledgerId, evidence: e.hash, seller: SELLER, buyer: BUYER }, T0);
    await run(T0);
    expect(row(e.ledgerId).state).toBe("not_slashable");
  });

  it("kind 2: the seller's valid rebuttal gets 2 veto signatures and the claim is vetoed", async () => {
    const { ledgerId, nonce } = await opened({ n: 105, receipt: null });
    expect(row(ledgerId).kind).toBe(2);
    await sign(ledgerId, 1);
    await run(T0 + 1000);
    const id = row(ledgerId).id;

    await expect(addRebuttal(id, { receipt: await receiptFor('{"rate":"x"}', { nonce }), body: '{"rate":"x"}' })).rejects.toMatchObject({ status: 400 });
    const { vetoDeadline } = await addRebuttal(id, { receipt: await receiptFor(GOOD, { nonce }), body: GOOD }, T0 + 2000);
    await expect(addRebuttal(id, { receipt: await receiptFor(GOOD, { nonce }), body: GOOD })).rejects.toMatchObject({ status: 409 });

    // the veto deadline is capped at the window's end: after it anyone may execute on chain
    expect(vetoDeadline).toBe(chain.claims.get(claimIdOf(SELLER, BUYER, nonce))!.executeAfter);
    await run(T0 + 10 * MIN);
    expect(row(ledgerId)).toMatchObject({ state: "proposed", vetoSignatures: [ADDR[0]] });
    const claimId = claimIdOf(SELLER, BUYER, nonce);
    expect(await addSignature(id, "veto", await signVeto(KEY[2], { id: claimId, deadline: BigInt(vetoDeadline) }, CONTRACT))).toMatchObject({ count: 2 });
    await run(T0 + 11 * MIN);
    expect(row(ledgerId).state).toBe("vetoed");
    expect(chain.claims.get(claimId)!.status).toBe(3);
  });

  it("kind 2: a rebuttal before the claim goes on chain drops it without a transaction", async () => {
    const { ledgerId, nonce } = await opened({ n: 108, receipt: null });
    expect(row(ledgerId)).toMatchObject({ state: "open", kind: 2 });
    await addRebuttal(row(ledgerId).id, { receipt: await receiptFor(GOOD, { nonce }), body: GOOD }, T0 + 1000);
    await sign(ledgerId, 1);
    await run(T0 + 2000);
    expect(row(ledgerId).state).toBe("vetoed");
    expect(chain.claims.get(claimIdOf(SELLER, BUYER, nonce))).toBeUndefined();
  });

  it("kind 2: a rebuttal after the slash window is refused", async () => {
    const { ledgerId, nonce } = await opened({ n: 109, receipt: null });
    await sign(ledgerId, 1);
    await run(T0 + 1000);
    await expect(addRebuttal(row(ledgerId).id, { receipt: await receiptFor(GOOD, { nonce }), body: GOOD }, T0 + 31 * MIN)).rejects.toMatchObject({ status: 409 });
  });

  it("adopts a claim the chain already has instead of proposing it again", async () => {
    const { ledgerId, nonce } = await opened({ n: 106 });
    const claimId = claimIdOf(SELLER, BUYER, nonce);
    chain.claims.set(claimId, { status: 1, executeAfter: Math.floor(T0 / 1000) + 1800, amount: 1000n });
    await run(T0 + 1000);
    expect(row(ledgerId)).toMatchObject({ state: "proposed", claimId, proposeTx: null });
    chain.claims.get(claimId)!.status = 2;
    await run(T0 + 2000);
    expect(row(ledgerId)).toMatchObject({ state: "executed", lastError: "state taken from the chain", paid: "1000" });
    expect(slashedTotal(SELLER)).toEqual({ count: 1, amount: 1000n }); // a keeper's execute counts like our own
  });

  it("closes a claim on an empty bond without a transaction", async () => {
    const { ledgerId, nonce } = await opened({ n: 110 });
    await sign(ledgerId, 1);
    chain.bond = 0n;
    await run(T0 + 1000);
    expect(row(ledgerId).state).toBe("no_bond");
    expect(chain.claims.get(claimIdOf(SELLER, BUYER, nonce))).toBeUndefined();
  });

  it("counts claims already on chain, each with its fee, against the bond", async () => {
    chain.bond = 22_000n; // room for one 0.001 claim and its 0.02 fee, and 0.001 more
    const a = await opened({ n: 111 });
    await sign(a.ledgerId, 1);
    await run(T0 + 1000);
    expect(row(a.ledgerId).state).toBe("proposed");

    const b = await opened({ n: 112 });
    await sign(b.ledgerId, 1);
    await run(T0 + 2000);
    expect(row(b.ledgerId).state).toBe("proposed");

    const c = await opened({ n: 113 });
    await sign(c.ledgerId, 1);
    await run(T0 + 3000);
    expect(row(c.ledgerId).state).toBe("no_bond");
  });

  it("holds a 4th claim until a slot frees, without sending a call the contract would refuse", async () => {
    const first = await opened({ n: 115 });
    await sign(first.ledgerId, 1);
    await run(T0 + 1000);
    for (const n of [116, 117]) {
      const o = await opened({ n });
      await sign(o.ledgerId, 1);
      await run(T0 + 1000);
    }
    const fourth = await opened({ n: 118 });
    await sign(fourth.ledgerId, 1);
    await run(T0 + 2000);
    expect(row(fourth.ledgerId)).toMatchObject({ state: "open", lastError: "waiting: this seller's 3 claim slots are in use" });

    await run(T0 + 31 * MIN); // the first three execute, and the 4th goes in the same pass
    expect(row(first.ledgerId).state).toBe("executed");
    expect(row(fourth.ledgerId).state).toBe("proposed");
  });

  it("a vetoed claim keeps its slot until its window ends", async () => {
    const first = await opened({ n: 119, receipt: null });
    await sign(first.ledgerId, 1);
    await run(T0 + 1000);
    for (const n of [120, 121]) {
      const o = await opened({ n });
      await sign(o.ledgerId, 1);
      await run(T0 + 1000);
    }
    const claimId = claimIdOf(SELLER, BUYER, first.nonce);
    chain.claims.get(claimId)!.status = 3;
    await run(T0 + 2000);
    expect(row(first.ledgerId).state).toBe("vetoed");

    const fourth = await opened({ n: 122 });
    await sign(fourth.ledgerId, 1);
    await run(T0 + 3000);
    expect(row(fourth.ledgerId).state).toBe("open");
  });

  it("retries, and does not close the claim, when the bond cannot be read", async () => {
    const { ledgerId } = await opened({ n: 114 });
    await sign(ledgerId, 1);
    chain.bond = new Error("rpc down");
    await run(T0 + 1000);
    expect(row(ledgerId)).toMatchObject({ state: "open", attempts: 1, lastError: "rpc down" });
  });

  it("files one claim per ledger row", async () => {
    const e = await evidence({ n: 107 });
    fileClaim({ ledgerId: e.ledgerId, evidence: e.hash, seller: SELLER, buyer: BUYER }, T0);
    fileClaim({ ledgerId: e.ledgerId, evidence: e.hash, seller: SELLER, buyer: BUYER }, T0);
    expect(listClaims().filter((c) => c.ledgerId === e.ledgerId)).toHaveLength(1);
  });
});

describe("stake claim routes", () => {
  const post = (path: string, body: unknown) => stakeRoutes.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("serves evidence byte for byte under its hash; 400 for a bad hash, 404 for an unknown one", async () => {
    const { hash } = await evidence({ n: 201 });
    const res = await stakeRoutes.request(`/evidence/${hash}`);
    expect(keccak256(toBytes(await res.text()))).toBe(hash);
    expect((await stakeRoutes.request("/evidence/0x12")).status).toBe(400);
    expect((await stakeRoutes.request(`/evidence/0x${"0".repeat(64)}`)).status).toBe(404);
  });

  it("refuses an unknown claim (404) and a malformed signature (400)", async () => {
    const sig = `0x${"ab".repeat(65)}`;
    expect((await post("/claims/999999/signature", { type: "claim", signature: sig })).status).toBe(404);
    expect((await post("/claims/1/signature", { type: "claim", signature: "0x12" })).status).toBe(400);
    expect((await post("/claims/1/signature", { type: "other", signature: sig })).status).toBe(400);
  });

  it("rate-limits relays: the 11th withdraw for one address within an hour gets 429", async () => {
    const seller = privateKeyToAccount(keccak256(toHex("rate-limited"))).address;
    for (let i = 0; i < 10; i++) expect((await post("/withdraw", { seller })).status).toBe(200);
    expect((await post("/withdraw", { seller })).status).toBe(429);
  });
});

describe("outside verifier (scripts/verifier.ts) against the real routes", () => {
  const logs: string[] = [];
  const verifier = (i: number, chainOpts: { signer?: Hex } = {}) => {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => stakeRoutes.request(url.replace("http://api/registry/stake", ""), init));
    return runOnce({ url: "http://api", key: KEY[i], contract: CONTRACT, chain: fakeChain(chainOpts), now: PAID_AT + 60n, log: (l) => logs.push(l) });
  };

  it("re-checks an open claim, signs it, never twice, and the worker then proposes", async () => {
    const { ledgerId } = await opened({ n: 301 });
    expect(await verifier(1)).toEqual({ signed: 1, vetoed: 0, failed: 0 });
    expect(row(ledgerId).signatures).toEqual([ADDR[0], ADDR[1]]);
    expect(await verifier(1)).toEqual({ signed: 0, vetoed: 0, failed: 0 });
    await run(T0 + 1000);
    expect(row(ledgerId).state).toBe("proposed");
  });

  it("will not sign a message the evidence does not back, or evidence that does not re-hash", async () => {
    const a = await opened({ n: 302 });
    db.prepare("UPDATE claims SET message = json_set(message, '$.amount', '99999') WHERE ledger_id = ?").run(a.ledgerId);
    const b = await opened({ n: 303 });
    db.prepare("UPDATE evidence SET bundle = replace(bundle, 'output breaks', 'output fits') WHERE hash = ?").run(b.hash);
    logs.length = 0;
    expect(await verifier(1)).toEqual({ signed: 0, vetoed: 0, failed: 0 });
    expect(logs.join("\n")).toMatch(/message differs/);
    expect(logs.join("\n")).toMatch(/does not match its hash/);
    expect(row(a.ledgerId).signatures).toEqual([ADDR[0]]);
  });

  it("signs a veto for a valid rebuttal, but not when its own chain check fails", async () => {
    const { ledgerId, nonce } = await opened({ n: 304, receipt: null });
    await sign(ledgerId, 1);
    await run(T0 + 1000);
    await addRebuttal(row(ledgerId).id, { receipt: await receiptFor(GOOD, { nonce }), body: GOOD }, T0 + 2000);
    expect(await verifier(2, { signer: zeroAddress })).toEqual({ signed: 0, vetoed: 0, failed: 0 }); // its chain shows no receipt signer
    expect(await verifier(2)).toEqual({ signed: 0, vetoed: 1, failed: 0 });
    await run(T0 + 3000);
    expect(row(ledgerId).state).toBe("vetoed");
  });
});
