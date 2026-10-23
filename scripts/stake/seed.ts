// Makes each built-in seller staked and slashable, through the running server's relay: it stakes part of its testnet
// earnings into SellerStakeV2, then registers RECEIPT_SIGNER_KEY as the seller's receipt signer (the relay needs a bond first).
// The sellers sign gasless messages with their SELLER_KEY_*; the server's relayer pays the gas and earns the stake fee.
// Usage: npm run stake:seed   (with the server running; GANDIVA_URL to target a public one)
import "dotenv/config";
import { createPublicClient, erc20Abi, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config, fromUnits, USDC_ADDRESS } from "../../src/config.js";
import { signStakeWithKey } from "../../src/stake/index.js";
import { api } from "../lib.js";

// [seller, bond target in units, before the stake fee]. junk-fx stakes too, so the junk test shows its bond refunding the buyer.
const plan: [string, bigint][] = [
  ["SHELF_SCRAPER", 200_000n],
  ["HINDI_SUMMARY", 100_000n],
  ["FX_RATES", 50_000n],
  ["CITY_INFO", 20_000n],
  ["SENTIMENT", 20_000n],
  ["JUNK_FX", 10_000n],
];

const pub = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
const info = await api<any>("/registry/stake");
if (!info.enabled) {
  console.log("Staking is not enabled on the server (deploy the contract, see docs/STAKE.md, then restart the server).");
  process.exit(1);
}
if (!config.stake.receiptSignerKey) {
  console.log("RECEIPT_SIGNER_KEY is not set (run npm run wallets:new): sellers would stake but stay unslashable.");
  process.exit(1);
}
const receiptSigner = privateKeyToAccount(config.stake.receiptSignerKey).address;
const stakeFee = BigInt(info.stakeFee);
const minStake = BigInt(info.minStake);

for (const [name, target] of plan) {
  const key = process.env[`SELLER_KEY_${name}`] as Hex | undefined;
  if (!key) continue;
  const seller = privateKeyToAccount(key);
  const address = seller.address;
  const pos = await api<any>(`/registry/stake/${address}`);
  let bonded = BigInt(pos.staked) > 0n;
  const need = target - BigInt(pos.staked);
  if (need <= 0n) {
    console.log(`${name.toLowerCase().padEnd(14)} already staked ${fromUnits(pos.staked)} USDC`);
  } else {
    const want = need + stakeFee < minStake ? minStake : need + stakeFee;
    const held = await pub.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    const amount = want < held ? want : held;
    if (amount < minStake) {
      console.log(`${name.toLowerCase().padEnd(14)} holds only ${fromUnits(held)} USDC, needs ${fromUnits(minStake)}; skipped (earn or fund ${address} first)`);
    } else {
      const signed = await signStakeWithKey(key, amount);
      const r = await api<any>("/registry/stake", signed);
      console.log(`${name.toLowerCase().padEnd(14)} staked ${fromUnits(amount)} USDC with the fee, bond now ${r.position.stakedUsdc}  ${r.explorer}`);
      bonded = true;
    }
  }
  if (bonded && pos.receiptSigner?.toLowerCase() !== receiptSigner.toLowerCase()) {
    const typed = await api<any>("/registry/stake/receipt-signer/prepare", { seller: address, signer: receiptSigner });
    const message = { ...typed.message, nonce: BigInt(typed.message.nonce), deadline: BigInt(typed.message.deadline) };
    const signature = await seller.signTypedData({ ...typed, domain: { ...typed.domain, chainId: BigInt(typed.domain.chainId) }, message });
    const r = await api<any>("/registry/stake/receipt-signer", { seller: address, signer: receiptSigner, deadline: typed.message.deadline, signature });
    console.log(`${name.toLowerCase().padEnd(14)} receipts now signed by ${receiptSigner}  ${r.explorer}`);
  }
}
