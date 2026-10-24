// Full rehearsal of staking on a local copy of Base Sepolia: the real contract build, the real USDC contract, and the
// server's own relayer, claim worker, HTTP routes and outside verifier. Spends nothing: every transaction stays in anvil,
// and all keys here are throwaway. What it cannot cover is a live x402 payment, so it makes the USDC payment directly.
// Usage: npm run stake:dry-run   (needs forge and anvil on PATH; FORK_RPC picks the chain to copy)
import "dotenv/config";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, parseAbi, parseSignature, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { ClaimMessage } from "../../src/stake/verify.js";

const PORT = 8599;
const API_PORT = 8598;
const RPC = `http://127.0.0.1:${PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const USDC_BALANCES_SLOT = 9n; // FiatToken v2.2: _balanceAndBlacklistStates
const SCHEMA = { type: "object", required: ["rate"], properties: { rate: { type: "number" } } };
const JUNK = '{"rate":"high"}';
const GOOD = '{"rate":1.2}';
const PRICE = 1_000n;
const BOND = 100_000n;
const FEE = 20_000n; // the deploy script's stake and slash fee
const START = 1_000_000n;

const fork = process.env.FORK_RPC || process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const tmp = mkdtempSync(join(tmpdir(), "gandiva-dry-run-"));
const key = { deployer: generatePrivateKey(), relayer: generatePrivateKey(), keeper: generatePrivateKey(), receipt: generatePrivateKey(), seller: generatePrivateKey(), buyer: generatePrivateKey(), v1: generatePrivateKey(), v2: generatePrivateKey(), v3: generatePrivateKey(), v4: generatePrivateKey() };
const addr = (k: Hex) => privateKeyToAccount(k).address;
const seller = addr(key.seller);
const buyer = addr(key.buyer);

const check = (ok: unknown, what: string) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`  ok  ${what}`);
};
const step = (s: string) => console.log(`\n${s}`);

const anvil = spawn("anvil", ["--fork-url", fork, "--port", String(PORT), "--silent"], { stdio: "ignore" });
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const test = createTestClient({ mode: "anvil", chain: baseSepolia, transport: http(RPC) });
const payer = createWalletClient({ account: privateKeyToAccount(key.relayer), chain: baseSepolia, transport: http(RPC) });

const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
const usdcOf = (a: Hex) => pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [a] });
const warp = async (seconds: number) => {
  await test.increaseTime({ seconds });
  await test.mine({ blocks: 1 });
};
const chainNow = async () => Number((await pub.getBlock()).timestamp) * 1000;
const fund = async (a: Hex) => {
  const index = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [a, USDC_BALANCES_SLOT]));
  await test.setStorageAt({ address: USDC, index, value: pad(toHex(START), { size: 32 }) });
};

/** The buyer's real USDC payment to the seller, as the x402 facilitator would settle it. */
async function pay(n: number): Promise<{ nonce: Hex; txHash: Hex }> {
  const nonce = keccak256(toHex(`payment-${n}`));
  const message = { from: buyer, to: seller, value: PRICE, validAfter: 0n, validBefore: 9_999_999_999n, nonce };
  const signature = await privateKeyToAccount(key.buyer).signTypedData({
    domain: { name: "USDC", version: "2", chainId: baseSepolia.id, verifyingContract: USDC },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message,
  });
  const { r, s, v, yParity } = parseSignature(signature);
  const txHash = await payer.writeContract({ address: USDC, abi: usdcAbi, functionName: "transferWithAuthorization", args: [buyer, seller, PRICE, 0n, 9_999_999_999n, nonce, Number(v ?? BigInt(yParity + 27)), r, s] });
  await pub.waitForTransactionReceipt({ hash: txHash });
  return { nonce, txHash };
}

async function main() {
  step("1. Local chain and contract");
  for (let i = 0; ; i++) {
    if (await pub.getChainId().catch(() => null)) break;
    if (i === 60) throw new Error(`anvil did not start (forking ${fork})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await test.setBalance({ address: addr(key.deployer), value: 10n ** 18n });
  await test.setBalance({ address: addr(key.relayer), value: 10n ** 18n });
  await test.setBalance({ address: addr(key.keeper), value: 10n ** 18n });
  await fund(seller);
  await fund(buyer);
  check((await usdcOf(buyer)) === START, "buyer and seller hold real USDC on the copy");

  // The real deploy script. Its record goes to a temp folder so a rehearsal never overwrites the record of a real deploy.
  const output = execFileSync("forge", ["script", "foundry/script/DeploySellerStakeV2.s.sol", "--rpc-url", RPC, "--private-key", key.deployer, "--broadcast"], {
    env: { ...process.env, VERIFIER_ADDRESSES: [addr(key.v1), addr(key.v2), addr(key.v3)].join(","), FOUNDRY_BROADCAST: join(tmp, "broadcast") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const contract = output.match(/SellerStakeV2 deployed at (0x[0-9a-fA-F]{40})/)?.[1] as Hex | undefined;
  check(contract, `deploy script put SellerStakeV2 at ${contract}`);

  // The server code reads these when it loads, so it is imported only now.
  Object.assign(process.env, {
    BASE_SEPOLIA_RPC: RPC,
    DB_PATH: join(tmp, "gandiva.db"),
    STAKE_CONTRACT: contract,
    RELAYER_PRIVATE_KEY: key.relayer,
    SERVER_VERIFIER_KEY: key.v1,
    RECEIPT_SIGNER_KEY: key.receipt,
    RELAY_MAX_GWEI: "1000", // anvil's gas price says nothing about the chain's; tests/stakeFees.test.ts covers the ceiling
  });
  const { serve } = await import("@hono/node-server");
  const { Hono } = await import("hono");
  const { fromUnits } = await import("../../src/config.js");
  const { db } = await import("../../src/db.js");
  const stake = await import("../../src/stake/index.js");
  const { fileClaim, listClaims, runClaims } = await import("../../src/stake/claims.js");
  const { saveEvidence } = await import("../../src/stake/evidence.js");
  const { outputHash, requestHash, schemaHash, signReceipt } = await import("../../src/stake/receipt.js");
  const { stakeRoutes } = await import("../../src/stake/routes.js");
  const { claimIdOf, rpcChainView, signClaim, signRotate, signVeto } = await import("../../src/stake/verify.js");
  const { runKeeper, rpcKeeperChain } = await import("../keeper.js");
  const { runOnce } = await import("../verifier.js");

  const app = new Hono();
  app.route("/registry/stake", stakeRoutes);
  const server = serve({ fetch: app.fetch, port: API_PORT, hostname: "127.0.0.1" });

  const quiet = () => {};
  const outside = (k: Hex) => runOnce({ url: API, key: k, contract: contract!, chain: rpcChainView(pub as any, contract!), log: quiet });
  const claimState = (ledgerId: number) => listClaims().find((c) => c.ledgerId === ledgerId)!;
  const receiptFor = (body: string, nonce: Hex) =>
    signReceipt(key.receipt, { payTo: seller, payer: buyer, paymentNonce: nonce, requestHash: requestHash("GET", "/fx", ""), outputHash: outputHash(body), schemaHash: schemaHash(SCHEMA), httpStatus: 200 });
  const evidence = (ledgerId: number, p: { nonce: Hex; txHash: Hex }, body: string | null, receipt: string | null) =>
    saveEvidence({
      chainId: baseSepolia.id,
      ledgerId,
      serviceId: "dry-run",
      reason: "output breaks listed schema",
      payment: { payTo: seller, payer: buyer, amount: PRICE.toString(), nonce: p.nonce, txHash: p.txHash },
      request: { method: "GET", path: "/fx", body: "" },
      outputSchema: SCHEMA,
      response: { status: 200, body, receipt },
    });

  try {
    step("2. Seller stakes and registers a receipt signer, gasless");
    const refused = await stake.relayReceiptSigner({ seller: buyer, signer: addr(key.receipt), deadline: "0", signature: "0x" }).then(() => "", (e: Error) => e.message);
    check(/stake first/.test(refused), "a wallet with no bond gets no free receipt signer");
    await stake.relayStake(await stake.signStakeWithKey(key.seller, BOND + FEE));
    const typed = await stake.prepareReceiptSigner(seller, addr(key.receipt));
    const signature = await privateKeyToAccount(key.seller).signTypedData({
      ...typed,
      domain: { ...typed.domain, chainId: BigInt(typed.domain.chainId) },
      message: { seller, signer: addr(key.receipt), nonce: BigInt(typed.message.nonce), deadline: BigInt(typed.message.deadline) },
    });
    await stake.relayReceiptSigner({ seller, signer: addr(key.receipt), deadline: typed.message.deadline, signature });
    const position = await stake.stakeOf(seller, true);
    check(position.staked === BOND.toString() && position.slashable, "bond is 0.10 USDC and the seller is slashable");
    check((await usdcOf(addr(key.relayer))) === FEE, "the 0.02 USDC stake fee reached the relayer");
    let bond = BOND;

    step("3. Junk answer with a valid receipt: kind 1 claim, refunded");
    const p1 = await pay(1);
    fileClaim({ ledgerId: 1, evidence: evidence(1, p1, JUNK, await receiptFor(JUNK, p1.nonce)), seller, buyer });
    await runClaims(); // the server's own checks
    await runClaims(); // and its signature
    check(claimState(1).state === "open" && claimState(1).kind === 1 && claimState(1).signatures.length === 1, "server verifier checked it and signed");
    check((await outside(key.v2)).signed === 1, "outside verifier re-checked it from the chain and signed");
    await runClaims();
    check(claimState(1).state === "proposed", "2 signatures, so the relayer proposed it on chain");
    const id1 = claimIdOf(seller, buyer, p1.nonce);
    check(await stake.executeOnChain(id1, seller).then(() => false, () => true), "the contract refuses to execute during the 30 minute window");
    await warp(1801);
    await runClaims(Date.now() + 1801_000);
    check(claimState(1).state === "executed" && claimState(1).paid === PRICE.toString(), "after the window the worker executed it");
    check((await usdcOf(buyer)) === START - PRICE + PRICE, "the buyer got its money back");
    bond -= PRICE + FEE;
    check((await stake.stakeOf(seller, true)).staked === bond.toString(), "the refund and the slash fee came out of the bond");
    check((await usdcOf(addr(key.relayer))) === 2n * FEE, "the slash fee reached the relayer");

    step("4. Paid, nothing valid came back: kind 2 claim, seller rebuts it");
    const p2 = await pay(2);
    fileClaim({ ledgerId: 2, evidence: evidence(2, p2, null, null), seller, buyer });
    await runClaims();
    await runClaims();
    check(claimState(2).state === "open" && claimState(2).kind === 2, "kind 2 claim opened");
    await outside(key.v2);
    await runClaims();
    check(claimState(2).state === "proposed", "proposed on chain");
    const rebut = await fetch(`${API}/registry/stake/claims/${claimState(2).id}/rebuttal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ receipt: await receiptFor(GOOD, p2.nonce), body: GOOD }) });
    check(rebut.ok, "the seller's rebuttal was accepted over HTTP");
    await runClaims();
    check((await outside(key.v2)).vetoed === 1, "outside verifier checked the rebuttal and signed a veto");
    await runClaims();
    check(claimState(2).state === "vetoed", "2 veto signatures closed the claim on chain");
    bond -= FEE;
    check((await stake.stakeOf(seller, true)).staked === bond.toString(), "no refund left the bond, only the slash fee");

    step("5. Verifier rotation");
    const set = [addr(key.v1), addr(key.v2), addr(key.v4)] as [Hex, Hex, Hex];
    const rotation = { set, nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 86_400) };
    const signers = [key.v1, key.v2].sort((a, b) => (BigInt(addr(a)) < BigInt(addr(b)) ? -1 : 1));
    await stake.rotateOnChain(set, rotation.deadline, await Promise.all(signers.map((k) => signRotate(k, rotation, contract!))));
    check((await stake.verifierSet()).includes(addr(key.v4)) && !(await stake.verifierSet()).includes(addr(key.v3)), "verifier 3 is out, verifier 4 is in");

    step("6. An outsider executes a refund first, so it earns the fee");
    const p4 = await pay(4);
    fileClaim({ ledgerId: 4, evidence: evidence(4, p4, JUNK, await receiptFor(JUNK, p4.nonce)), seller, buyer });
    await runClaims();
    await runClaims();
    await outside(key.v2);
    await runClaims();
    check(claimState(4).state === "proposed", "proposed on chain");
    await warp(1801);
    const keeper = createWalletClient({ account: privateKeyToAccount(key.keeper), chain: baseSepolia, transport: http(RPC) });
    const keeperTx = await keeper.writeContract({ address: contract!, abi: parseAbi(["function executeSlash(bytes32 id) returns (uint256)"]), functionName: "executeSlash", args: [claimIdOf(seller, buyer, p4.nonce)] });
    await pub.waitForTransactionReceipt({ hash: keeperTx });
    await runClaims();
    check(claimState(4).state === "executed" && claimState(4).paid === PRICE.toString(), "the worker adopted it and read the real refund from the chain");
    check((await usdcOf(addr(key.keeper))) === FEE, "the fee went to the outsider that paid the gas");
    bond -= PRICE + FEE;

    step("7. A rotated-out key, and a bond held back by an open claim");
    const p3 = await pay(3);
    fileClaim({ ledgerId: 3, evidence: evidence(3, p3, JUNK, await receiptFor(JUNK, p3.nonce)), seller, buyer });
    await runClaims();
    await runClaims();
    check((await outside(key.v3)).failed === 1 && claimState(3).signatures.length === 1, "the server refused the rotated-out verifier's signature");
    check((await outside(key.v4)).signed === 1, "the new verifier's signature counted");
    await runClaims(await chainNow()); // on the chain's clock: the warps put the earlier claims' windows in the real future
    check(claimState(3).state === "proposed", "proposed on chain");

    const unstake = await stake.prepareUnstake(seller);
    // From the chain's clock, not prepareUnstake's: the warps above have moved this chain about an hour past the real time.
    const unstakeBy = (await pub.getBlock()).timestamp + 3600n;
    const unstakeSig = await privateKeyToAccount(key.seller).signTypedData({
      ...unstake,
      domain: { ...unstake.domain, chainId: BigInt(unstake.domain.chainId) },
      message: { seller, nonce: BigInt(unstake.message.nonce), deadline: unstakeBy },
    });
    await stake.relayUnstake({ seller, deadline: unstakeBy.toString(), signature: unstakeSig });
    check(await stake.relayUnstake({ seller, deadline: unstakeBy.toString(), signature: unstakeSig }).then(() => false, (e: Error) => /already unstaking/.test(e.message)), "a repeat unstake is refused before it costs gas");
    await warp(7201);
    check(await stake.withdrawFor(seller).then(() => false, () => true), "withdraw is refused while the claim is open");
    await runClaims(Date.now() + 9100_000);
    check(claimState(3).state === "executed", "the claim executed");
    await stake.withdrawFor(seller);

    step("8. The money adds up");
    const refunds = 3n * PRICE;
    check((await usdcOf(buyer)) === START - 4n * PRICE + refunds, "buyer: paid 4 times, refunded 3 times");
    check((await usdcOf(seller)) === START + 4n * PRICE - refunds - 5n * FEE, "seller: got 4 payments, paid 3 refunds and 5 fees, the rest came back");
    check((await usdcOf(addr(key.relayer))) === 4n * FEE, "relayer: earned 4 fees");
    check((await usdcOf(addr(key.keeper))) === FEE, "outsider: earned 1 fee");
    check((await usdcOf(contract!)) === 0n, "the contract holds nothing");

    step("9. A claim against an empty bond costs no gas");
    const before = stake.relayerBook();
    const p5 = await pay(5);
    fileClaim({ ledgerId: 5, evidence: evidence(5, p5, JUNK, await receiptFor(JUNK, p5.nonce)), seller, buyer });
    await runClaims();
    await runClaims();
    await outside(key.v2);
    await runClaims(await chainNow());
    check(claimState(5).state === "no_bond", "closed without going on chain");
    check(stake.relayerBook().txs === before.txs, "the relayer sent nothing");

    step("10. The relayer's book");
    const book = stake.relayerBook();
    check(book.feesUsdc === fromUnits(4n * FEE), `${book.txs} transactions, ${book.gasEth} ETH of gas, ${book.feesUsdc} USDC of fees`);
    for (const r of db.prepare("SELECT fn, MAX(CAST(gas_used AS INTEGER)) AS gas FROM relayer_book GROUP BY fn ORDER BY id").all() as { fn: string; gas: number }[]) console.log(`      ${r.fn}: ${r.gas} gas`);

    step("11. Drill: 2 stolen verifier keys, with the API down");
    await fund(seller);
    const LARGE = 500_000n;
    const inHour = (await pub.getBlock()).timestamp + 3600n; // the chain's clock again: it is hours ahead by now
    const typedStake = stake.prepareStake(seller, LARGE + FEE);
    const stakeSig = await privateKeyToAccount(key.seller).signTypedData({ ...typedStake, message: { ...typedStake.message, value: LARGE + FEE, validAfter: 0n, validBefore: inHour } });
    await stake.relayStake({ from: seller, value: (LARGE + FEE).toString(), validAfter: "0", validBefore: inHour.toString(), nonce: typedStake.message.nonce, signature: stakeSig });
    const thief = addr(generatePrivateKey());
    const madeUp = (n: number): ClaimMessage => ({ seller, buyer: thief, amount: 100_000n, paymentNonce: keccak256(toHex(`made-up-${n}`)), evidence: keccak256(toHex("none")), kind: 1, deadline: inHour });
    const stolen = async (m: ClaimMessage, keys: Hex[]) => Promise.all([...keys].sort((a, b) => (BigInt(addr(a)) < BigInt(addr(b)) ? -1 : 1)).map((k) => signClaim(k, m, contract!)));
    check(await stake.proposeOnChain(madeUp(1), await stolen(madeUp(1), [key.v1])).then(() => false, () => true), "1 stolen key cannot open a claim");
    for (const n of [1, 2, 3]) await stake.proposeOnChain(madeUp(n), await stolen(madeUp(n), [key.v1, key.v2]));
    const fourth = await stake.proposeOnChain(madeUp(4), await stolen(madeUp(4), [key.v1, key.v2])).then(() => "", (e: Error) => e.message);
    check(/too many claims/.test(fourth), "2 stolen keys open 3 claims, and the 4th is refused");
    const firstId = claimIdOf(seller, thief, madeUp(1).paymentNonce);
    const vetoSigs = await Promise.all([key.v1, key.v2].sort((a, b) => (BigInt(addr(a)) < BigInt(addr(b)) ? -1 : 1)).map((k) => signVeto(k, { id: firstId, deadline: inHour }, contract!)));
    await stake.vetoOnChain(firstId, inHour, vetoSigs);
    const looped = await stake.proposeOnChain(madeUp(5), await stolen(madeUp(5), [key.v1, key.v2])).then(() => "", (e: Error) => e.message);
    check(/too many claims/.test(looped), "vetoing their own claim frees no slot, so they cannot loop for fees");

    await warp(2701);
    const backup = rpcKeeperChain(pub as any, key.keeper, contract!, keeper as any);
    const pass = await runKeeper({ chain: backup, lookback: 500n, log: quiet });
    check(pass.executed === 2 && pass.failed === 0, "with the API down, the backup job executed the other 2 from the chain alone");
    check((await runKeeper({ chain: backup, lookback: 500n, log: quiet })).executed === 0, "a second pass sends nothing");
    check((await usdcOf(thief)) === 200_000n, "the thief got those 2 refunds and no more");
    check((await stake.stakeOf(seller, true)).staked === (LARGE - 200_000n - 3n * FEE).toString(), "the rest of the bond is safe: at most 0.36 USDC per 30 minutes can leave");
  } finally {
    server.close();
  }
}

try {
  await main();
  console.log("\nDRY RUN PASSED: nothing was spent.");
} catch (err: any) {
  console.error(`\n${err?.shortMessage ?? err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  anvil.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {} // Windows may still hold the database file; it is in the temp folder either way
}
process.exit();
