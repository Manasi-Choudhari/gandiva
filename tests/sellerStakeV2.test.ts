import { readFileSync } from "node:fs";
import { createEVM, type EVM } from "@ethereumjs/evm";
import { createAddressFromString, createZeroAddress } from "@ethereumjs/util";
import solc from "solc";
import { beforeEach, describe, expect, it } from "vitest";
import { bytesToHex, decodeErrorResult, decodeFunctionResult, encodeDeployData, encodeFunctionData, hexToBytes, keccak256, parseSignature, toHex, type Abi, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { claimIdOf, rotateSignerOf, signClaim, signRotate, signVeto } from "../src/stake/verify.js";

// SellerStakeV2 against a mock USDC in an in-process EVM: 2-of-3 verifier slashing, the window and veto, rotation, the
// receipt signer and the cooldown, plus a seeded fuzz run that checks the money invariants after every step.
const MOCK_USDC = `
pragma solidity ^0.8.20;
contract MockUSDC {
  mapping(address => uint256) public balanceOf;
  mapping(bytes32 => bool) public used;
  mapping(address => bool) public blocked;
  function mint(address to, uint256 v) external { balanceOf[to] += v; }
  function setBlocked(address a) external { blocked[a] = true; }
  function receiveWithAuthorization(address from, address to, uint256 value, uint256, uint256, bytes32 nonce, uint8, bytes32, bytes32) external {
    require(msg.sender == to, "caller must be the payee");
    require(!used[nonce], "authorization used");
    used[nonce] = true;
    require(balanceOf[from] >= value, "balance");
    balanceOf[from] -= value;
    balanceOf[to] += value;
  }
  function transfer(address to, uint256 v) external returns (bool) {
    require(!blocked[to], "blocked");
    require(balanceOf[msg.sender] >= v, "balance");
    balanceOf[msg.sender] -= v;
    balanceOf[to] += v;
    return true;
  }
}`;

// The stake contract is the real build artifact (npm run stake:compile); only the mock token is compiled here.
function compile(): Record<string, { abi: Abi; bytecode: Hex }> {
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "MockUSDC.sol": { content: MOCK_USDC } },
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
      }),
    ),
  );
  const errors = (out.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: any) => e.formattedMessage).join("\n"));
  const mock = out.contracts["MockUSDC.sol"].MockUSDC;
  return { stake: JSON.parse(readFileSync("contracts/SellerStakeV2.json", "utf8")), usdc: { abi: mock.abi, bytecode: `0x${mock.evm.bytecode.object}` as Hex } };
}

const artifacts = compile();
const acct = (label: string) => privateKeyToAccount(keccak256(toHex(label)));
const deployer = acct("deployer");
const seller = acct("seller");
const buyer = acct("buyer");
const relayer = acct("relayer");
const receiptKey = acct("receipt-signer");
const outsider = acct("outsider");
const V = [acct("verifier-1"), acct("verifier-2"), acct("verifier-3")];
const keyOf = (a: PrivateKeyAccount) => keccak256(toHex(`verifier-${V.indexOf(a) + 1}`));
const COOLDOWN = 7200n;
const WINDOW = 1800n;
const MAX = 100_000n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // secp256k1 order

let evm: EVM;
let now: bigint;
let usdcAddr: Hex;
let stakeAddr: Hex;
let authN: number;

const addr = (a: Hex) => createAddressFromString(a);
const block = () => ({ header: { number: 1n, coinbase: createZeroAddress(), timestamp: now, difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n, baseFeePerGas: 0n, getBlobGasPrice: () => undefined } });

async function run(from: Hex, data: Hex, to?: Hex) {
  const r = await evm.runCall({ caller: addr(from), to: to && addr(to), data: hexToBytes(data), block: block(), gasLimit: 10_000_000n });
  if (r.execResult.exceptionError) {
    let reason: string = r.execResult.exceptionError.error;
    try {
      reason = String(decodeErrorResult({ abi: [], data: bytesToHex(r.execResult.returnValue) }).args?.[0] ?? reason);
    } catch {}
    throw new Error(reason);
  }
  return r;
}

const deploy = async (a: { abi: Abi; bytecode: Hex }, args: unknown[] = []) =>
  (await run(deployer.address, encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }))).createdAddress!.toString() as Hex;

async function call(from: Hex, to: Hex, abi: Abi, functionName: string, args: unknown[] = []) {
  const r = await run(from, encodeFunctionData({ abi, functionName, args }), to);
  return decodeFunctionResult({ abi, functionName, data: bytesToHex(r.execResult.returnValue) }) as any;
}

const S = (from: Hex, fn: string, args: unknown[] = []) => call(from, stakeAddr, artifacts.stake.abi, fn, args);
const U = (from: Hex, fn: string, args: unknown[] = []) => call(from, usdcAddr, artifacts.usdc.abi, fn, args);
const usdcOf = (a: Hex) => U(relayer.address, "balanceOf", [a]) as Promise<bigint>;
const nonce = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const stake = (value: bigint, who = seller) =>
  S(relayer.address, "stakeWithAuthorization", [who.address, value, 0n, now + 3600n, nonce(++authN), 27, nonce(1), nonce(2)]);

const T = {
  Claim: [
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "paymentNonce", type: "bytes32" },
    { name: "evidence", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "deadline", type: "uint256" },
  ],
  Veto: [{ name: "id", type: "bytes32" }, { name: "deadline", type: "uint256" }],
  Rotate: [
    { name: "verifier1", type: "address" },
    { name: "verifier2", type: "address" },
    { name: "verifier3", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  SetReceiptSigner: [{ name: "seller", type: "address" }, { name: "signer", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
  Unstake: [{ name: "seller", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
} as const;

const sign = (a: PrivateKeyAccount, primaryType: keyof typeof T, message: Record<string, unknown>) =>
  a.signTypedData({ domain: { name: "Gandiva SellerStake", version: "2", chainId: 1n, verifyingContract: stakeAddr }, types: { [primaryType]: T[primaryType] }, primaryType, message } as any);
const byAddress = (as: PrivateKeyAccount[]) => [...as].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
const sigs = (as: PrivateKeyAccount[], primaryType: keyof typeof T, message: Record<string, unknown>) => Promise.all(byAddress(as).map((a) => sign(a, primaryType, message)));
const vrs = (sig: Hex) => {
  const { v, r, s, yParity } = parseSignature(sig);
  return [Number(v ?? BigInt(yParity + 27)), r, s] as const;
};

type ClaimMsg = { seller: Hex; buyer: Hex; amount: bigint; paymentNonce: Hex; evidence: Hex; kind: number; deadline: bigint };
const claim = (o: Partial<ClaimMsg> = {}): ClaimMsg => ({ seller: seller.address, buyer: buyer.address, amount: 40_000n, paymentNonce: nonce(77), evidence: nonce(88), kind: 1, deadline: now + 600n, ...o });
const propose = async (c = claim(), signers = [V[0], V[1]]) => S(relayer.address, "proposeSlash", [c, await sigs(signers, "Claim", c)]);
const idOf = (c: ClaimMsg) => S(relayer.address, "claimId", [c.seller, c.buyer, c.paymentNonce]) as Promise<Hex>;
async function veto(id: Hex, signers = [V[0], V[2]]) {
  const m = { id, deadline: now + 600n };
  return S(relayer.address, "vetoSlash", [id, m.deadline, await sigs(signers, "Veto", m)]);
}
async function rotate(set: Hex[], signers: PrivateKeyAccount[], rotationNonce: bigint) {
  const m = { verifier1: set[0], verifier2: set[1], verifier3: set[2], nonce: rotationNonce, deadline: now + 600n };
  return S(relayer.address, "rotateVerifiers", [set, m.deadline, await sigs(signers, "Rotate", m)]);
}
async function receiptSignerArgs(o: { who?: PrivateKeyAccount; signer?: Hex; signedBy?: PrivateKeyAccount; sigNonce?: bigint; deadline?: bigint } = {}) {
  const who = o.who ?? seller;
  const signer = o.signer ?? receiptKey.address;
  const deadline = o.deadline ?? now + 60n;
  const sig = await sign(o.signedBy ?? who, "SetReceiptSigner", { seller: who.address, signer, nonce: o.sigNonce ?? 0n, deadline });
  return [who.address, signer, deadline, ...vrs(sig)];
}
const register = async (who = seller) => S(relayer.address, "setReceiptSignerWithSig", await receiptSignerArgs({ who }));

beforeEach(async () => {
  evm = await createEVM();
  now = 1_800_000_000n;
  authN = 0;
  usdcAddr = await deploy(artifacts.usdc);
  stakeAddr = await deploy(artifacts.stake, [usdcAddr, V.map((a) => a.address), COOLDOWN, 0n, 0n]);
  await U(deployer.address, "mint", [seller.address, 1_000_000n]);
});

describe("SellerStakeV2", () => {
  it("refuses a cooldown shorter than the claim deadline plus the window, and a bad verifier set", async () => {
    const vs = V.map((a) => a.address);
    await expect(deploy(artifacts.stake, [usdcAddr, vs, 5400n, 0n, 0n])).rejects.toThrow(/cooldown too short/);
    await expect(deploy(artifacts.stake, [usdcAddr, [vs[0], vs[0], vs[2]], COOLDOWN, 0n, 0n])).rejects.toThrow(/duplicate verifier/);
    await expect(deploy(artifacts.stake, [usdcAddr, [vs[0], vs[1], "0x0000000000000000000000000000000000000000"], COOLDOWN, 0n, 0n])).rejects.toThrow(/zero verifier/);
    await expect(deploy(artifacts.stake, [usdcAddr, vs, COOLDOWN, MAX + 1n, 0n])).rejects.toThrow(/fee too high/);
  });

  it("pays each fee to whoever sent the transaction, after the buyer's refund", async () => {
    stakeAddr = await deploy(artifacts.stake, [usdcAddr, V.map((a) => a.address), COOLDOWN, 20_000n, 20_000n]);
    await register();
    await stake(120_000n); // 0.10 bond + 0.02 fee
    expect(await usdcOf(relayer.address)).toBe(20_000n);
    expect(await S(relayer.address, "stakeOf", [seller.address])).toBe(100_000n);
    const c = claim();
    await propose(c);
    now += WINDOW;
    expect(await S(outsider.address, "executeSlash", [await idOf(c)])).toBe(40_000n);
    expect(await usdcOf(buyer.address)).toBe(40_000n);
    expect(await usdcOf(outsider.address)).toBe(20_000n);
    expect(await S(relayer.address, "stakeOf", [seller.address])).toBe(40_000n);
    expect(await usdcOf(stakeAddr)).toBe(40_000n);
  });

  it("registers a receipt signer from the seller's gasless signature, once", async () => {
    const args = await receiptSignerArgs();
    await S(relayer.address, "setReceiptSignerWithSig", args);
    expect(await S(relayer.address, "receiptSigner", [seller.address])).toBe(receiptKey.address);
    await expect(S(relayer.address, "setReceiptSignerWithSig", args)).rejects.toThrow(/bad signature/);
    await expect(S(relayer.address, "setReceiptSignerWithSig", await receiptSignerArgs({ signedBy: outsider, sigNonce: 1n }))).rejects.toThrow(/bad signature/);
    await expect(S(relayer.address, "setReceiptSignerWithSig", await receiptSignerArgs({ sigNonce: 1n, deadline: now - 1n }))).rejects.toThrow(/signature expired/);
    const zero = await receiptSignerArgs({ sigNonce: 1n, signer: "0x0000000000000000000000000000000000000000" });
    await expect(S(relayer.address, "setReceiptSignerWithSig", zero)).rejects.toThrow(/zero signer/);
  });

  it("cannot slash a seller with no receipt signer", async () => {
    await stake(50_000n);
    await expect(propose()).rejects.toThrow(/not slashable/);
  });

  it("slashes with 2 of 3 verifiers only after the window, and refunds the buyer once", async () => {
    await register();
    await stake(50_000n);
    const c = claim();
    await propose(c);
    const id = await idOf(c);
    expect(await S(relayer.address, "pendingCount", [seller.address])).toBe(1n);
    await expect(S(relayer.address, "executeSlash", [id])).rejects.toThrow(/window open/);
    now += WINDOW;
    expect(await S(outsider.address, "executeSlash", [id])).toBe(40_000n);
    expect(await usdcOf(buyer.address)).toBe(40_000n);
    expect(await S(relayer.address, "stakeOf", [seller.address])).toBe(10_000n);
    expect(await S(relayer.address, "totalStaked")).toBe(10_000n);
    expect(await S(relayer.address, "pendingCount", [seller.address])).toBe(0n);
    expect((await S(relayer.address, "claims", [id]))[4]).toBe(2); // Executed
    await expect(S(relayer.address, "executeSlash", [id])).rejects.toThrow(/not pending/);
  });

  it("rejects one signature, a duplicate, an unsorted pair, a non-verifier and a tampered claim", async () => {
    await register();
    await stake(50_000n);
    const c = claim();
    const [a, b] = await sigs([V[0], V[1]], "Claim", c);
    await expect(S(relayer.address, "proposeSlash", [c, [a]])).rejects.toThrow(/not enough signatures/);
    await expect(S(relayer.address, "proposeSlash", [c, [a, a]])).rejects.toThrow(/signers not sorted/);
    await expect(S(relayer.address, "proposeSlash", [c, [b, a]])).rejects.toThrow(/signers not sorted/);
    await expect(S(relayer.address, "proposeSlash", [c, await sigs([V[0], outsider], "Claim", c)])).rejects.toThrow(/not a verifier/);
    await expect(S(relayer.address, "proposeSlash", [{ ...c, amount: 99_999n }, [a, b]])).rejects.toThrow(/not a verifier|signers not sorted/);
    await S(relayer.address, "proposeSlash", [c, [a, b]]);
  });

  it("rejects a malleable (high-s) copy of a valid signature", async () => {
    await register();
    await stake(50_000n);
    const c = claim();
    const [a, b] = await sigs([V[0], V[1]], "Claim", c);
    const highS = (N - BigInt(`0x${b.slice(66, 130)}`)).toString(16).padStart(64, "0");
    const flipped = `0x${b.slice(2, 66)}${highS}${b.slice(130) === "1b" ? "1c" : "1b"}` as Hex;
    await expect(S(relayer.address, "proposeSlash", [c, [a, flipped]])).rejects.toThrow(/bad signature/);
  });

  it("caps a slash at 0.10 USDC and rejects zero, an unknown kind and an expired signature", async () => {
    await register();
    await stake(500_000n);
    await expect(propose(claim({ amount: MAX + 1n }))).rejects.toThrow(/bad amount/);
    await expect(propose(claim({ amount: 0n }))).rejects.toThrow(/bad amount/);
    await expect(propose(claim({ kind: 3 }))).rejects.toThrow(/bad kind/);
    await expect(propose(claim({ deadline: now - 1n }))).rejects.toThrow(/signature expired/);
    await propose(claim({ amount: MAX, kind: 2 }));
  });

  it("lets a payment back at most one claim, even after a veto", async () => {
    await register();
    await stake(50_000n);
    const c = claim();
    await propose(c);
    await veto(await idOf(c));
    await expect(propose({ ...c, amount: 1n, evidence: nonce(99) })).rejects.toThrow(/evidence used/);
    await propose({ ...c, buyer: outsider.address }); // a different buyer's payment is a different payment
  });

  it("lets 2 of 3 verifiers veto during the window, and after it when the refund cannot be paid", async () => {
    await register();
    await stake(50_000n);
    const c1 = claim();
    await propose(c1);
    const id1 = await idOf(c1);
    await expect(veto(id1, [V[0]])).rejects.toThrow(/not enough signatures/);
    await veto(id1);
    expect((await S(relayer.address, "claims", [id1]))[4]).toBe(3); // Vetoed
    await expect(veto(id1)).rejects.toThrow(/not pending/);
    now += WINDOW;
    await expect(S(relayer.address, "executeSlash", [id1])).rejects.toThrow(/not pending/);

    const c2 = claim({ paymentNonce: nonce(78) });
    await propose(c2);
    const id2 = await idOf(c2);
    await U(deployer.address, "setBlocked", [buyer.address]);
    now += WINDOW;
    await expect(S(relayer.address, "executeSlash", [id2])).rejects.toThrow(/blocked/);
    await veto(id2);
    expect(await S(relayer.address, "pendingCount", [seller.address])).toBe(0n);
    expect(await S(relayer.address, "stakeOf", [seller.address])).toBe(50_000n);
  });

  it("accepts the claim and veto signatures the server and verifiers make (src/stake/verify.ts)", async () => {
    await register();
    await stake(50_000n);
    const c = claim();
    const pair = byAddress([V[0], V[2]]);
    await S(relayer.address, "proposeSlash", [c, await Promise.all(pair.map((a) => signClaim(keyOf(a), c, stakeAddr, 1)))]);
    const id = claimIdOf(c.seller, c.buyer, c.paymentNonce);
    expect(await idOf(c)).toBe(id);
    const v = { id, deadline: now + 600n };
    await S(relayer.address, "vetoSlash", [id, v.deadline, await Promise.all(pair.map((a) => signVeto(keyOf(a), v, stakeAddr, 1)))]);
    expect((await S(relayer.address, "claims", [id]))[4]).toBe(3); // Vetoed
  });

  it("pays only what is left of the bond, and closes a claim with 0 when nothing is left", async () => {
    await register();
    await stake(30_000n);
    const cs = [claim({ amount: 20_000n, paymentNonce: nonce(1) }), claim({ amount: 20_000n, paymentNonce: nonce(2) }), claim({ amount: 5_000n, paymentNonce: nonce(3) })];
    for (const c of cs) await propose(c);
    now += WINDOW;
    const paid = [];
    for (const c of cs) paid.push(await S(relayer.address, "executeSlash", [await idOf(c)]));
    expect(paid).toEqual([20_000n, 10_000n, 0n]);
    expect(await usdcOf(buyer.address)).toBe(30_000n);
    expect(await S(relayer.address, "pendingCount", [seller.address])).toBe(0n);
  });

  it("blocks withdraw while a claim is open, then releases what is left", async () => {
    await register();
    await stake(50_000n);
    await propose();
    await S(seller.address, "requestUnstake");
    now += COOLDOWN;
    await expect(S(relayer.address, "withdraw", [seller.address])).rejects.toThrow(/claims pending/);
    await S(relayer.address, "executeSlash", [await idOf(claim())]);
    await S(relayer.address, "withdraw", [seller.address]);
    expect(await usdcOf(seller.address)).toBe(960_000n);
    expect(await S(relayer.address, "stakeOf", [seller.address])).toBe(0n);
  });

  it("keeps the bond locked through the cooldown, and staking again cancels the unstake", async () => {
    await stake(20_000n);
    await S(seller.address, "requestUnstake");
    now += COOLDOWN - 1n;
    await expect(S(relayer.address, "withdraw", [seller.address])).rejects.toThrow(/still locked/);
    await stake(1_000n);
    now += COOLDOWN;
    await expect(S(relayer.address, "withdraw", [seller.address])).rejects.toThrow(/still locked/);
    await S(seller.address, "requestUnstake");
    now += COOLDOWN;
    await S(relayer.address, "withdraw", [seller.address]);
    expect(await usdcOf(seller.address)).toBe(1_000_000n);
  });

  it("accepts a gasless unstake signed by the seller, once, sharing the nonce with the receipt signer", async () => {
    await register(); // uses nonce 0
    await stake(20_000n);
    const deadline = now + 60n;
    const unstake = async (n: bigint, by = seller) => [seller.address, deadline, ...vrs(await sign(by, "Unstake", { seller: seller.address, nonce: n, deadline }))];
    await expect(S(relayer.address, "requestUnstakeWithSig", await unstake(1n, outsider))).rejects.toThrow(/bad signature/);
    const args = await unstake(1n);
    await S(relayer.address, "requestUnstakeWithSig", args);
    expect(await S(relayer.address, "unlockAt", [seller.address])).toBe(now + COOLDOWN);
    await expect(S(relayer.address, "requestUnstakeWithSig", args)).rejects.toThrow(/bad signature/);
  });

  it("rotates the verifier set with 2 of 3, and rotated-out verifiers lose their power", async () => {
    await register();
    await stake(50_000n);
    const v4 = acct("verifier-4");
    const set = [V[0].address, V[1].address, v4.address];
    await expect(rotate(set, [V[0]], 0n)).rejects.toThrow(/not enough signatures/);
    await rotate(set, [V[0], V[2]], 0n);
    expect(await S(relayer.address, "verifiers", [2n])).toBe(v4.address);
    expect(await S(relayer.address, "rotationNonce")).toBe(1n);
    await expect(rotate(set, [V[0], V[1]], 0n)).rejects.toThrow(/not a verifier|signers not sorted/); // old nonce
    await expect(propose(claim(), [V[0], V[2]])).rejects.toThrow(/not a verifier/);
    await propose(claim(), [V[1], v4]);
    await expect(rotate([set[0], set[0], set[2]], [V[0], V[1]], 1n)).rejects.toThrow(/duplicate verifier/);
  });

  it("accepts a rotation signed with signRotate (the stake:rotate script's signer)", async () => {
    const set = [V[0].address, acct("verifier-5").address, V[2].address] as [Hex, Hex, Hex];
    const m = { set, nonce: 0n, deadline: now + 600n };
    const pair = byAddress([V[0], V[1]]);
    const signed = await Promise.all(pair.map((a) => signRotate(keyOf(a), m, stakeAddr, 1)));
    expect(await Promise.all(signed.map((s) => rotateSignerOf(m, s, stakeAddr, 1)))).toEqual(pair.map((a) => a.address));
    await S(relayer.address, "rotateVerifiers", [set, m.deadline, signed]);
    expect(await S(relayer.address, "verifiers", [1n])).toBe(set[1]);
  });
});

// Deterministic PRNG (mulberry32) so a failing seed can be replayed.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random stake / unstake / withdraw / propose / veto / execute / time-warp steps, checked against a plain model of the
// contract. After every step: the contract's USDC == totalStaked == sum of the model's stakes, and every stake and
// pending count matches. Each execute must pay min(claim, stake left) <= 0.10 USDC, and only once.
async function fuzz(seed: number, steps: number) {
  const rand = mulberry32(seed);
  const int = (n: number) => Math.floor(rand() * n);
  const pick = <X>(xs: readonly X[]) => xs[int(xs.length)];
  const sellers = [seller, acct("seller-2"), acct("seller-3")];
  const slashable = new Set([sellers[0].address, sellers[1].address]); // seller-3 never registers a receipt signer
  for (const s of sellers.slice(1)) await U(deployer.address, "mint", [s.address, 10_000_000n]);
  await U(deployer.address, "mint", [seller.address, 9_000_000n]);
  for (const s of sellers.slice(0, 2)) await register(s);

  const staked = new Map<Hex, bigint>(sellers.map((s) => [s.address, 0n]));
  const unlock = new Map<Hex, bigint>(sellers.map((s) => [s.address, 0n]));
  const claims = new Map<Hex, { seller: Hex; amount: bigint; executeAfter: bigint; status: "pending" | "executed" | "vetoed" }>();
  const pending = (s: Hex) => [...claims.values()].filter((c) => c.seller === s && c.status === "pending").length;
  const attempt = (fn: string, args: unknown[], from = relayer.address) => S(from, fn, args).then((r) => ({ ok: true, r }), (e: Error) => ({ ok: false, r: e.message }));
  const done = { proposed: 0, vetoed: 0, paid: 0, withdrawn: 0 };

  for (let step = 0; step < steps; step++) {
    const s = pick(sellers);
    const op = int(7);
    const where = `seed ${seed} step ${step} op ${op}`;
    if (op === 0) {
      const v = BigInt(1 + int(60_000));
      await stake(v, s);
      staked.set(s.address, staked.get(s.address)! + v);
      unlock.set(s.address, 0n);
    } else if (op === 1) {
      const res = await attempt("requestUnstake", [], s.address);
      expect(res.ok, `${where} ${res.r}`).toBe(staked.get(s.address)! > 0n);
      if (res.ok) unlock.set(s.address, now + COOLDOWN);
    } else if (op === 2) {
      const before = await usdcOf(s.address);
      const t = unlock.get(s.address)!;
      const res = await attempt("withdraw", [s.address]);
      expect(res.ok, `${where} ${res.r}`).toBe(t !== 0n && now >= t && pending(s.address) === 0);
      if (res.ok) {
        expect((await usdcOf(s.address)) - before, where).toBe(staked.get(s.address));
        staked.set(s.address, 0n);
        unlock.set(s.address, 0n);
        done.withdrawn++;
      }
    } else if (op === 3) {
      const signers = [...V].sort(() => rand() - 0.5).slice(0, 1 + int(3));
      const c = claim({ seller: s.address, amount: BigInt(1 + int(120_000)), paymentNonce: nonce(int(6)), kind: 1 + int(2) });
      const id = await idOf(c);
      const res = await attempt("proposeSlash", [c, await sigs(signers, "Claim", c)]);
      const holdingSlots = [...claims.values()].filter((x) => x.seller === s.address && x.executeAfter > now).length;
      expect(res.ok, `${where} ${res.r}`).toBe(signers.length >= 2 && c.amount <= MAX && slashable.has(s.address) && !claims.has(id) && holdingSlots < 3);
      if (res.ok) {
        claims.set(id, { seller: s.address, amount: c.amount, executeAfter: now + WINDOW, status: "pending" });
        done.proposed++;
      }
    } else if (op === 4 || op === 5) {
      if (!claims.size) continue;
      const id = pick([...claims.keys()]);
      const cl = claims.get(id)!;
      if (op === 4) {
        const res = await attempt("vetoSlash", [id, now + 600n, await sigs([V[1], V[2]], "Veto", { id, deadline: now + 600n })]);
        expect(res.ok, `${where} ${res.r}`).toBe(cl.status === "pending");
        if (res.ok) {
          cl.status = "vetoed";
          done.vetoed++;
        }
      } else {
        const before = await usdcOf(buyer.address);
        const res = await attempt("executeSlash", [id]);
        expect(res.ok, `${where} ${res.r}`).toBe(cl.status === "pending" && now >= cl.executeAfter);
        if (res.ok) {
          const left = staked.get(cl.seller)!;
          const paid = cl.amount < left ? cl.amount : left;
          expect(res.r, where).toBe(paid);
          expect((await usdcOf(buyer.address)) - before, where).toBe(paid);
          expect(paid <= MAX, where).toBe(true);
          staked.set(cl.seller, left - paid);
          cl.status = "executed";
          if (paid > 0n) done.paid++;
        }
      }
    } else {
      now += BigInt(int(3 * 3600));
    }

    const total = await S(relayer.address, "totalStaked");
    expect(await usdcOf(stakeAddr), where).toBe(total);
    expect(total, where).toBe([...staked.values()].reduce((a, b) => a + b, 0n));
    for (const x of sellers) {
      expect(await S(relayer.address, "stakeOf", [x.address]), where).toBe(staked.get(x.address));
      expect(await S(relayer.address, "pendingCount", [x.address]), where).toBe(BigInt(pending(x.address)));
    }
  }
  // A run that never reached a path proves nothing about it.
  for (const [k, n] of Object.entries(done)) expect(n, `seed ${seed}: no ${k}`).toBeGreaterThan(0);
}

describe("SellerStakeV2 invariants (fuzz)", () => {
  for (const seed of [1, 2, 3]) it(`seed ${seed}: the bond money always adds up, and no claim pays twice or above the cap`, () => fuzz(seed, 250), 120_000);
});
