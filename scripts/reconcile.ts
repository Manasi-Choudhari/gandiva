// Reconciliation: the ledger's charged entries must equal the USDC transfers out of the buyer wallet, to the unit.
// 1) every charged ledger row's tx must contain a USDC Transfer buyer -> listed payTo of exactly the paid amount
// 2) a full log scan of USDC transfers from the buyer since the first ledger tx must sum to the same total
//    (an agent wallet's withdrawals back to its owner are outgoing transfers too, so they are added to the ledger side)
// Usage: npm run reconcile [-- [--quick] <wallet address>]   (default: the shared demo wallet; pass a user's agent wallet to check it)
// --quick does only check 1. The full log scan grows with the wallet's age, too slow for the public RPC on a daily schedule.
import { createPublicClient, http, parseAbiItem, parseEventLogs, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config, USDC_ADDRESS } from "../src/config.js";
import { api, units } from "./lib.js";

const client = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
const args = process.argv.slice(2);
const quick = args.includes("--quick");
const buyer = (args.find((a) => a !== "--quick") || privateKeyToAccount(config.buyerPrivateKey as `0x${string}`).address).toLowerCase();

const { entries } = await api<{ entries: any[] }>(`/registry/ledger?buyer=${buyer}`);
const { withdrawals } = await api<{ withdrawals: any[] }>(`/registry/withdrawals?buyer=${buyer}`);
const unknownWithdrawals = withdrawals.filter((w) => w.status === "unknown");
if (unknownWithdrawals.length) {
  console.log(`buyer ${buyer}`);
  console.log(`\nNOT RECONCILED: ${unknownWithdrawals.length} withdrawal(s) have an unknown outcome (the request failed after signing). Check the wallet balance on the explorer, then retry.`);
  process.exit(1);
}
const withdrawn = withdrawals.filter((w) => w.status === "settled").reduce((a, w) => a + BigInt(w.amount), 0n);
// An "unconfirmed" row is a payment whose outcome is not known yet. Reconciliation cannot be trusted while any exist:
// the background resolver settles them from the chain within a minute or two, then re-run this script.
const unconfirmed = entries.filter((e) => e.status === "unconfirmed" && e.buyer.toLowerCase() === buyer);
if (unconfirmed.length) {
  console.log(`buyer ${buyer}`);
  console.log(`\nNOT RECONCILED: ${unconfirmed.length} ledger row(s) are still "unconfirmed" (payment signed, outcome unknown):`);
  for (const e of unconfirmed) console.log(`  - #${e.id} ${e.service_name} asked ${e.asked} units, valid until ${e.valid_before ? new Date(e.valid_before * 1000).toISOString() : "?"}: ${e.reason}`);
  console.log("The resolver checks the chain every 15 s and settles them once the authorisation is used or expired. Wait and re-run.");
  process.exit(1);
}

const charged = entries.filter((e) => (e.status === "paid" || e.status === "paid_output_rejected") && e.buyer.toLowerCase() === buyer);
let ledgerTotal = 0n;
let verified = 0n;
let firstBlock: bigint | null = null;
const problems: string[] = [];

for (const e of charged) {
  ledgerTotal += BigInt(e.paid);
  if (!e.tx_hash) {
    problems.push(`ledger #${e.id} charged ${e.paid} but has no tx hash`);
    continue;
  }
  const receipt = await client.getTransactionReceipt({ hash: e.tx_hash });
  if (firstBlock === null || receipt.blockNumber < firstBlock) firstBlock = receipt.blockNumber;
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === USDC_ADDRESS.toLowerCase() && l.args.from.toLowerCase() === buyer,
  );
  const match = transfers.find((l) => l.args.to.toLowerCase() === e.seller.toLowerCase() && l.args.value === BigInt(e.paid));
  if (match) verified += BigInt(e.paid);
  else problems.push(`ledger #${e.id} tx ${e.tx_hash}: no USDC transfer of ${e.paid} from buyer to ${e.seller}`);
}

console.log(`buyer ${buyer}`);
console.log(`ledger charged entries: ${charged.length}, total ${ledgerTotal} units (${units(ledgerTotal)} USDC)`);
console.log(`verified on-chain per tx: ${verified} units`);

// Judge scripts (replay, standard-client) sign with the buyer key directly, bypassing Scout's ledger.
// Our sellers still record those in their sales table, so account for them separately.
const ledgerTxs = new Set(charged.map((e) => e.tx_hash?.toLowerCase()));
const { sales } = await api<{ sales: any[] }>("/registry/sales");
const direct = sales.filter((s) => s.status === "paid" && s.payer?.toLowerCase() === buyer && s.tx_hash && !ledgerTxs.has(s.tx_hash.toLowerCase()));
const directTotal = direct.reduce((a, s) => a + BigInt(s.amount), 0n);
for (const s of direct) {
  const receipt = await client.getTransactionReceipt({ hash: s.tx_hash });
  if (firstBlock === null || receipt.blockNumber < firstBlock) firstBlock = receipt.blockNumber;
}
// A withdrawal can come before the first purchase (fund, withdraw, fund again, run): start the chain scan early enough to see it.
for (const w of withdrawals.filter((w) => w.status === "settled")) {
  if (!w.tx_hash) {
    problems.push(`withdrawal #${w.id} is settled but has no tx hash`);
    continue;
  }
  const receipt = await client.getTransactionReceipt({ hash: w.tx_hash });
  if (firstBlock === null || receipt.blockNumber < firstBlock) firstBlock = receipt.blockNumber;
}

if (firstBlock !== null && !quick) {
  const latest = await client.getBlockNumber();
  const event = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  let chainTotal = 0n;
  let count = 0;
  // Public RPCs cap eth_getLogs ranges (sepolia.base.org: 200 blocks), so shrink the step when told to.
  let step = 9_000n;
  const fetchRange = (from: bigint, to: bigint) =>
    client.getLogs({ address: USDC_ADDRESS, event, args: { from: buyer as `0x${string}` }, fromBlock: from, toBlock: to });
  try {
    await fetchRange(firstBlock, firstBlock + step > latest ? latest : firstBlock + step);
  } catch (err: any) {
    const cap = /limited to a (\d+) range/i.exec(String(err?.details ?? err?.message ?? ""));
    if (!cap) throw err;
    step = BigInt(cap[1]) - 1n;
  }
  const ranges: [bigint, bigint][] = [];
  for (let from = firstBlock; from <= latest; from += step + 1n) ranges.push([from, from + step > latest ? latest : from + step]);
  process.stdout.write(`scanning ${latest - firstBlock + 1n} blocks in ${ranges.length} chunks...`);
  const PARALLEL = 8;
  for (let i = 0; i < ranges.length; i += PARALLEL) {
    const batch = await Promise.all(ranges.slice(i, i + PARALLEL).map(([f, t]) => fetchRange(f, t)));
    for (const logs of batch)
      for (const l of logs) {
        chainTotal += l.args.value ?? 0n;
        count++;
      }
  }
  process.stdout.write(" done\n");
  console.log(`chain: ${count} USDC transfers out of buyer since block ${firstBlock}, total ${chainTotal} units (${units(chainTotal)} USDC)`);

  if (direct.length) console.log(`direct payments by test scripts (seller sales, not via Scout): ${direct.length}, total ${directTotal} units`);
  if (withdrawn) console.log(`withdrawals back to the owner: ${withdrawals.filter((w) => w.status === "settled").length}, total ${withdrawn} units`);
  console.log(`ledger ${ledgerTotal} + direct ${directTotal} + withdrawn ${withdrawn} = ${ledgerTotal + directTotal + withdrawn} units vs chain ${chainTotal} units`);
  if (chainTotal !== ledgerTotal + directTotal + withdrawn) problems.push(`chain total ${chainTotal} != ledger ${ledgerTotal} + direct ${directTotal} + withdrawn ${withdrawn}`);
}

if (problems.length) {
  console.log("\nMISMATCHES:\n" + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
console.log(quick ? "\nRECONCILED (quick): every charged ledger row matches its transaction. The full transfer scan was skipped." : "\nRECONCILED: ledger matches the chain to the last unit.");
