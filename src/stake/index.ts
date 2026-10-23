import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Mutex } from "async-mutex";
import { createPublicClient, createWalletClient, decodeEventLog, formatEther, http, parseGwei, parseSignature, verifyTypedData, zeroAddress, type Abi, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config, EXPLORER_TX, fromUnits, USDC_ADDRESS, USDC_EIP712 } from "../config.js";
import { db } from "../db.js";
import { logRanges } from "../x402/chain.js";
import { rpcChainView, stakeDomain as v2Domain, type ClaimMessage } from "./verify.js";

/** Smallest stake worth relaying (0.02 fee plus 0.01 bond) and the largest single authorisation we accept. */
export const MIN_STAKE = 30_000n;
export const MAX_STAKE = 5_000_000n;
/** Below this the relayer warns: it pays the gas for every stake, claim and refund. */
const LOW_ETH = 2_000_000_000_000_000n; // 0.002 ETH
/** A seller may change its receipt signer this often: the stake fee only prepays the first one. */
const SIGNER_CHANGES_PER_DAY = 3;
/** SellerStakeV2.CLAIMS_PER_WINDOW: past this the contract refuses a proposal, so the worker waits for a slot instead. */
export const CLAIMS_PER_WINDOW = 3;
const BLOCK_SECONDS = 2n;

const artifact = JSON.parse(readFileSync(fileURLToPath(new URL("../../contracts/SellerStakeV2.json", import.meta.url)), "utf8")) as { abi: Abi };
const abi = artifact.abi;

db.exec(`
CREATE TABLE IF NOT EXISTS stake_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  seller TEXT NOT NULL,
  counterparty TEXT,
  amount TEXT NOT NULL DEFAULT '0',
  tx_hash TEXT,
  ledger_id INTEGER,
  status TEXT NOT NULL,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS stake_events_slash_once ON stake_events (ledger_id) WHERE kind = 'slash';
CREATE TABLE IF NOT EXISTS relayer_book (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  fn TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  gas_used TEXT NOT NULL,
  gas_wei TEXT NOT NULL,
  fee TEXT NOT NULL DEFAULT '0'
);
`);

export class StakeError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 429 | 503 = 400) {
    super(message);
  }
}

/** Unit tests never touch the chain, even when .env names a deployed contract. */
export const stakeEnabled = () => Boolean(config.stake.contract && config.stake.relayerKey && !process.env.VITEST);

const pub = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
let relayerWallet: ReturnType<typeof makeRelayer> | null = null;
function makeRelayer() {
  const account = privateKeyToAccount(config.stake.relayerKey as Hex);
  return { account, client: createWalletClient({ account, chain: baseSepolia, transport: http(config.rpcUrl) }) };
}
/** Pays the gas for every relayed call. SellerStakeV2 gives it no powers: it can only submit what others signed. */
const relayer = () => (relayerWallet ??= makeRelayer());
// One transaction at a time from the relayer, so concurrent relays never reuse a nonce.
const sendLock = new Mutex();

export const contract = () => {
  if (!stakeEnabled()) throw new StakeError("staking is not configured on this server (STAKE_CONTRACT / RELAYER_PRIVATE_KEY)", 503);
  return config.stake.contract as Hex;
};

/** True above the gas ceiling, where the fees no longer cover a relayed seller action. */
export const overCeiling = (gasPriceWei: bigint, maxGwei: string) => gasPriceWei > parseGwei(maxGwei);

/**
 * `capped` sends wait out expensive gas: seller actions do, since a seller can always send its own transaction. Claims,
 * vetoes and refunds never do, because a buyer's refund comes before the relayer's margin.
 */
async function send(functionName: string, args: unknown[], o: { capped?: boolean } = {}): Promise<{ hash: Hex; block: bigint; logs: Log[] }> {
  const address = contract();
  return sendLock.runExclusive(async () => {
    if (o.capped && overCeiling(await pub.getGasPrice(), config.stake.relayMaxGwei)) throw new StakeError("gas is unusually expensive right now, so the relayer is paused; try again later", 503);
    // Simulating first means a call that would revert costs the relayer no gas.
    const { request } = await pub.simulateContract({ account: relayer().account, address, abi, functionName, args });
    const hash = await relayer().client.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    // Booked before the status check: a reverted transaction still cost gas.
    const fee = eventIn(receipt.logs, "FeePaid")?.amount ?? 0n;
    db.prepare("INSERT INTO relayer_book (ts,fn,tx_hash,gas_used,gas_wei,fee) VALUES (?,?,?,?,?,?)").run(
      new Date().toISOString(), functionName, hash, receipt.gasUsed.toString(), (receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n)).toString(), fee.toString(),
    );
    if (receipt.status !== "success") throw new StakeError(`${functionName} reverted (tx ${hash})`, 409);
    return { hash, block: receipt.blockNumber, logs: receipt.logs };
  });
}

/** What the relayer has spent on gas and earned in fees, so its operator can see whether the fees still cover it. */
export function relayerBook() {
  // TOTAL, not SUM: wei totals pass what SQLite integers hold, and this is a dashboard figure, so a float is fine.
  const r = db.prepare("SELECT COUNT(*) AS txs, TOTAL(CAST(gas_wei AS REAL)) AS gas, TOTAL(CAST(fee AS REAL)) AS fees FROM relayer_book").get() as { txs: number; gas: number; fees: number };
  return { txs: r.txs, gasEth: formatEther(BigInt(Math.round(r.gas))), feesUsdc: fromUnits(BigInt(Math.round(r.fees))) };
}

/** The first event called `name` that our contract emitted in these logs. */
function eventIn(logs: Log[], name: string): Record<string, any> | undefined {
  for (const log of logs) {
    if (log.address.toLowerCase() !== config.stake.contract.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi, data: log.data, topics: log.topics }) as { eventName: string; args: Record<string, any> };
      if (e.eventName === name) return e.args;
    } catch {}
  }
  return undefined;
}

const cache = new Map<string, { at: number; value: StakePosition }>();
export interface StakePosition {
  staked: string;
  stakedUsdc: string;
  /** Unix seconds after which the bond can be withdrawn; 0 = not unstaking. */
  unlockAt: number;
  /** Key that signs this seller's receipts; null when none is registered. */
  receiptSigner: string | null;
  /** True when a receipt signer is registered, so verifiers can slash the bond for junk. */
  slashable: boolean;
}
const EMPTY: StakePosition = { staked: "0", stakedUsdc: "0.000000", unlockAt: 0, receiptSigner: null, slashable: false };

/**
 * Reads a seller's bond from the contract (cached for 20 s). Zero when staking is off or the chain cannot be reached.
 * `atBlock` pins the read to the block of our own write: the public RPC is load-balanced and "latest" can lag behind it.
 */
export async function stakeOf(seller: string, fresh = false, atBlock?: bigint): Promise<StakePosition> {
  if (!stakeEnabled()) return EMPTY;
  const key = seller.toLowerCase();
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 20_000) return hit.value;
  const address = contract();
  for (let attempt = 0; attempt < (atBlock ? 5 : 1); attempt++) {
    try {
      const [staked, unlockAt, signer] = await Promise.all([
        pub.readContract({ address, abi, functionName: "stakeOf", args: [seller], blockNumber: atBlock }) as Promise<bigint>,
        pub.readContract({ address, abi, functionName: "unlockAt", args: [seller], blockNumber: atBlock }) as Promise<bigint>,
        pub.readContract({ address, abi, functionName: "receiptSigner", args: [seller], blockNumber: atBlock }) as Promise<Hex>,
      ]);
      const receiptSigner = signer === zeroAddress ? null : signer;
      const value = { staked: staked.toString(), stakedUsdc: fromUnits(staked), unlockAt: Number(unlockAt), receiptSigner, slashable: receiptSigner !== null };
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch {
      if (atBlock) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return hit?.value ?? EMPTY;
}

/** A cached bond is good enough to let a seller through; only a zero is worth a fresh read, as our last write may not show yet. */
async function bondedPosition(seller: string): Promise<StakePosition> {
  const pos = await stakeOf(seller);
  return pos.staked === "0" ? stakeOf(seller, true) : pos;
}

/** The bond as the chain has it now. Unlike stakeOf this throws when the chain cannot be reached, so a claim is never closed on a failed read. */
export const bondOnChain = (seller: string) => pub.readContract({ address: contract(), abi, functionName: "stakeOf", args: [seller] }) as Promise<bigint>;

let feeCache: { stakeFee: bigint; slashFee: bigint } | null = null;
/** Fixed at deploy, so read once. */
export async function stakeFees() {
  if (!feeCache) {
    const address = contract();
    const [stakeFee, slashFee] = await Promise.all([
      pub.readContract({ address, abi, functionName: "stakeFee" }) as Promise<bigint>,
      pub.readContract({ address, abi, functionName: "slashFee" }) as Promise<bigint>,
    ]);
    feeCache = { stakeFee, slashFee };
  }
  return feeCache;
}

let infoCache: { at: number; cooldown: number; total: string } | null = null;
export async function stakeInfo() {
  if (!stakeEnabled()) return { enabled: false as const };
  const fees = await stakeFees();
  if (!infoCache || Date.now() - infoCache.at > 30_000) {
    const address = contract();
    const [cooldown, total] = await Promise.all([
      pub.readContract({ address, abi, functionName: "cooldown" }) as Promise<bigint>,
      pub.readContract({ address, abi, functionName: "totalStaked" }) as Promise<bigint>,
    ]);
    infoCache = { at: Date.now(), cooldown: Number(cooldown), total: total.toString() };
  }
  return {
    enabled: true as const,
    contract: config.stake.contract,
    relayer: { ...(await relayerStatus()), ...relayerBook() },
    verifiers: await verifierSet(),
    cooldownSeconds: infoCache.cooldown,
    totalStaked: infoCache.total,
    totalStakedUsdc: fromUnits(infoCache.total),
    minStake: MIN_STAKE.toString(),
    stakeFee: fees.stakeFee.toString(),
    slashFee: fees.slashFee.toString(),
    explorer: `https://sepolia.basescan.org/address/${config.stake.contract}`,
  };
}

const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const usdcDomain = { name: USDC_EIP712.name, version: USDC_EIP712.version, chainId: baseSepolia.id, verifyingContract: USDC_ADDRESS as Hex } as const;

/** EIP-712 data the seller signs in its wallet to stake `amount` units, fee included. Signing costs nothing; the relayer relays it. */
export function prepareStake(seller: string, amount: bigint) {
  if (amount < MIN_STAKE || amount > MAX_STAKE) throw new StakeError(`stake must be between ${fromUnits(MIN_STAKE)} and ${fromUnits(MAX_STAKE)} USDC`);
  const message = {
    from: seller as Hex,
    to: contract(),
    value: amount.toString(),
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 3600),
    nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
  };
  return { domain: usdcDomain, types: RECEIVE_TYPES, primaryType: "ReceiveWithAuthorization" as const, message };
}

export interface SignedStake {
  from: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
}

/** Relays a signed stake to the contract. The signature is checked here first so a bad one never costs gas. */
export async function relayStake(s: SignedStake): Promise<{ txHash: string; explorer: string; position: StakePosition }> {
  const to = contract();
  const value = BigInt(s.value);
  if (value < MIN_STAKE || value > MAX_STAKE) throw new StakeError(`stake must be between ${fromUnits(MIN_STAKE)} and ${fromUnits(MAX_STAKE)} USDC`);
  const message = { from: s.from as Hex, to, value, validAfter: BigInt(s.validAfter), validBefore: BigInt(s.validBefore), nonce: s.nonce as Hex };
  const ok = await verifyTypedData({ address: s.from as Hex, domain: usdcDomain, types: RECEIVE_TYPES, primaryType: "ReceiveWithAuthorization", message, signature: s.signature as Hex }).catch(() => false);
  if (!ok) throw new StakeError("the stake signature does not match the seller and amount");
  const { r, s: sv, v, yParity } = parseSignature(s.signature as Hex);
  let sent: { hash: Hex; block: bigint };
  try {
    sent = await send("stakeWithAuthorization", [message.from, value, message.validAfter, message.validBefore, message.nonce, Number(v ?? BigInt(yParity + 27)), r, sv], { capped: true });
  } catch (err: any) {
    record({ kind: "stake", seller: s.from, amount: s.value, status: "failed", note: shortError(err) });
    throw err instanceof StakeError ? err : new StakeError(`stake rejected: ${shortError(err)}`, 409);
  }
  const txHash = sent.hash;
  infoCache = null;
  record({ kind: "stake", seller: s.from, amount: s.value, txHash, status: "done" });
  return { txHash, explorer: EXPLORER_TX + txHash, position: await stakeOf(s.from, true, sent.block) };
}

/** Signs a stake with a private key we hold (the built-in sellers' testnet wallets). */
export async function signStakeWithKey(privateKey: Hex, amount: bigint): Promise<SignedStake> {
  const account = privateKeyToAccount(privateKey);
  const typed = prepareStake(account.address, amount);
  const signature = await account.signTypedData({ ...typed, message: { ...typed.message, value: BigInt(typed.message.value), validAfter: 0n, validBefore: BigInt(typed.message.validBefore) } });
  return { from: account.address, value: typed.message.value, validAfter: "0", validBefore: typed.message.validBefore, nonce: typed.message.nonce, signature };
}

const UNSTAKE_TYPES = {
  Unstake: [
    { name: "seller", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
// A number chainId: this domain goes out as JSON to the seller's wallet, and JSON cannot carry a bigint.
const stakeDomain = () => ({ ...v2Domain(contract()), chainId: baseSepolia.id });

export async function prepareUnstake(seller: string) {
  const nonce = (await pub.readContract({ address: contract(), abi, functionName: "nonces", args: [seller] })) as bigint;
  return { domain: stakeDomain(), types: UNSTAKE_TYPES, primaryType: "Unstake" as const, message: { seller, nonce: nonce.toString(), deadline: String(Math.floor(Date.now() / 1000) + 3600) } };
}

export async function relayUnstake(u: { seller: string; deadline: string; signature: string }) {
  contract();
  // The contract would accept a repeat, and each one would cost the relayer gas that no fee covers.
  const pos = await bondedPosition(u.seller);
  if (pos.staked === "0") throw new StakeError("nothing staked", 409);
  if (pos.unlockAt) throw new StakeError("already unstaking", 409);
  const { r, s, v, yParity } = parseSignature(u.signature as Hex);
  let sent: { hash: Hex; block: bigint };
  try {
    sent = await send("requestUnstakeWithSig", [u.seller, BigInt(u.deadline), Number(v ?? BigInt(yParity + 27)), r, s], { capped: true });
  } catch (err: any) {
    throw err instanceof StakeError ? err : new StakeError(`unstake rejected: ${shortError(err)}`, 409);
  }
  const txHash = sent.hash;
  record({ kind: "unstake", seller: u.seller, txHash, status: "done" });
  return { txHash, explorer: EXPLORER_TX + txHash, position: await stakeOf(u.seller, true, sent.block) };
}

/** Releases a bond whose cooldown is over. Anyone may ask; the money only ever goes back to the seller. */
export async function withdrawFor(seller: string) {
  const before = await stakeOf(seller, true);
  let sent: { hash: Hex; block: bigint };
  try {
    sent = await send("withdraw", [seller], { capped: true });
  } catch (err: any) {
    throw err instanceof StakeError ? err : new StakeError(`withdraw rejected: ${shortError(err)}`, 409);
  }
  const txHash = sent.hash;
  infoCache = null;
  record({ kind: "withdraw", seller, amount: before.staked, txHash, status: "done" });
  return { txHash, explorer: EXPLORER_TX + txHash, position: await stakeOf(seller, true, sent.block) };
}

// ---- receipt signer (makes a seller slashable) ----

const RECEIPT_SIGNER_TYPES = {
  SetReceiptSigner: [
    { name: "seller", type: "address" },
    { name: "signer", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export async function prepareReceiptSigner(seller: string, signer: string) {
  const nonce = (await pub.readContract({ address: contract(), abi, functionName: "nonces", args: [seller] })) as bigint;
  return {
    domain: stakeDomain(),
    types: RECEIPT_SIGNER_TYPES,
    primaryType: "SetReceiptSigner" as const,
    message: { seller, signer, nonce: nonce.toString(), deadline: String(Math.floor(Date.now() / 1000) + 3600) },
  };
}

/** Counted from stake_events rather than the in-memory rate limit, so a server restart does not reset it. */
export function signerChangesToday(seller: string, now = Date.now()): number {
  const since = new Date(now - 86_400_000).toISOString();
  const r = db.prepare("SELECT COUNT(*) AS n FROM stake_events WHERE kind = 'receipt-signer' AND status = 'done' AND lower(seller) = ? AND ts > ?").get(seller.toLowerCase(), since) as { n: number };
  return r.n;
}

export async function relayReceiptSigner(b: { seller: string; signer: string; deadline: string; signature: string }) {
  contract();
  // Only a seller that paid the stake fee gets a relayed signer; anyone else would be free gas.
  if ((await bondedPosition(b.seller)).staked === "0") throw new StakeError("stake first: the relayer only registers a receipt signer for a bonded seller", 409);
  if (signerChangesToday(b.seller) >= SIGNER_CHANGES_PER_DAY) throw new StakeError(`at most ${SIGNER_CHANGES_PER_DAY} receipt signer changes a day`, 429);
  const { r, s, v, yParity } = parseSignature(b.signature as Hex);
  let sent: { hash: Hex };
  try {
    sent = await send("setReceiptSignerWithSig", [b.seller, b.signer, BigInt(b.deadline), Number(v ?? BigInt(yParity + 27)), r, s], { capped: true });
  } catch (err: any) {
    throw err instanceof StakeError ? err : new StakeError(`receipt signer rejected: ${shortError(err)}`, 409);
  }
  record({ kind: "receipt-signer", seller: b.seller, counterparty: b.signer, txHash: sent.hash, status: "done" });
  return { txHash: sent.hash, explorer: EXPLORER_TX + sent.hash };
}

// ---- claims on chain (the worker in claims.ts drives these) ----

let verifierCache: { at: number; set: Hex[] } | null = null;
/** The current 3 verifiers (cached 60 s). */
export async function verifierSet(): Promise<Hex[]> {
  if (!verifierCache || Date.now() - verifierCache.at > 60_000) {
    const address = contract();
    const set = await Promise.all([0n, 1n, 2n].map((i) => pub.readContract({ address, abi, functionName: "verifiers", args: [i] }) as Promise<Hex>));
    verifierCache = { at: Date.now(), set };
  }
  return verifierCache.set;
}

/** Submits a rotation 2 of the current verifiers signed (sigs sorted by signer). */
export async function rotateOnChain(set: Hex[], deadline: bigint, sigs: Hex[]): Promise<{ txHash: Hex; explorer: string }> {
  const sent = await send("rotateVerifiers", [set, deadline, sigs]);
  verifierCache = null;
  return { txHash: sent.hash, explorer: EXPLORER_TX + sent.hash };
}

export const chainView = () => rpcChainView(pub as any, contract());

/** status: 0 none, 1 pending, 2 executed, 3 vetoed (SellerStakeV2.Status). */
export async function claimOnChain(id: Hex): Promise<{ status: number; executeAfter: number }> {
  const [, , , executeAfter, status] = (await pub.readContract({ address: contract(), abi, functionName: "claims", args: [id] })) as [Hex, Hex, bigint, bigint, number];
  return { status: Number(status), executeAfter: Number(executeAfter) };
}

const toChain = (m: ClaimMessage) => ({ ...m, kind: Number(m.kind) });

export async function proposeOnChain(m: ClaimMessage, sigs: Hex[]): Promise<{ txHash: Hex; id: Hex; executeAfter: number }> {
  const sent = await send("proposeSlash", [toChain(m), sigs]);
  const e = eventIn(sent.logs, "SlashProposed");
  if (!e) throw new Error(`proposeSlash tx ${sent.hash} has no SlashProposed event`);
  return { txHash: sent.hash, id: e.id, executeAfter: Number(e.executeAfter) };
}

export async function vetoOnChain(id: Hex, deadline: bigint, sigs: Hex[]): Promise<{ txHash: Hex }> {
  return { txHash: (await send("vetoSlash", [id, deadline, sigs])).hash };
}

/** The refund actually paid comes from the Slashed event (it is capped by what is left of the bond). */
export async function executeOnChain(id: Hex, seller: string): Promise<{ txHash: Hex; paid: bigint }> {
  const sent = await send("executeSlash", [id]);
  const e = eventIn(sent.logs, "Slashed");
  infoCache = null;
  cache.delete(seller.toLowerCase());
  return { txHash: sent.hash, paid: BigInt(e?.amount ?? 0n) };
}

/** The refund paid by an execute someone else sent. Null when no Slashed event is found. `executeAfter` says where to start looking. */
export async function slashedOnChain(id: Hex, executeAfter: number): Promise<bigint | null> {
  const head = await pub.getBlock();
  const back = (head.timestamp > BigInt(executeAfter) ? head.timestamp - BigInt(executeAfter) : 0n) / BLOCK_SECONDS + 100n;
  const start = head.number > back ? head.number - back : 0n;
  for (const [from, to] of logRanges(start, head.number)) {
    const logs = (await pub.getContractEvents({ address: contract(), abi, eventName: "Slashed", args: { id }, fromBlock: from, toBlock: to })) as unknown as { args: { amount: bigint } }[];
    if (logs[0]) return logs[0].args.amount;
  }
  return null;
}

export async function relayerStatus(): Promise<{ address: Hex; eth: string; low: boolean }> {
  const address = relayer().account.address;
  const wei = await pub.getBalance({ address });
  return { address, eth: formatEther(wei), low: wei < LOW_ETH };
}

function record(e: { kind: string; seller: string; counterparty?: string; amount?: string; txHash?: string; status: string; note?: string }) {
  db.prepare("INSERT INTO stake_events (ts,kind,seller,counterparty,amount,tx_hash,status,note) VALUES (?,?,?,?,?,?,?,?)").run(
    new Date().toISOString(), e.kind, e.seller, e.counterparty ?? null, e.amount ?? "0", e.txHash ?? null, e.status, e.note ?? null,
  );
}

export function listStakeEvents(q: { seller?: string; limit?: number } = {}) {
  const rows = q.seller
    ? db.prepare("SELECT * FROM stake_events WHERE lower(seller) = ? ORDER BY id DESC LIMIT ?").all(q.seller.toLowerCase(), q.limit ?? 200)
    : db.prepare("SELECT * FROM stake_events ORDER BY id DESC LIMIT ?").all(q.limit ?? 200);
  return (rows as any[]).map((r) => ({ ...r, explorer: r.tx_hash ? EXPLORER_TX + r.tx_hash : null }));
}

const shortError = (err: any) => String(err?.shortMessage ?? err?.message ?? err).split("\n")[0].slice(0, 200);
