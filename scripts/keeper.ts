// Backup for the server's claim worker. It reads only the chain, so it still works with the API down: a claim past its window
// that nobody has executed gets executed here, and the sender earns the slash fee. It needs no trust, because SellerStakeV2
// only ever pays the claim's buyer and the sender. A healthy server gets there first; the keeper waits GRACE_S so it can.
// Usage: npm run keeper   (one pass, for cron / GitHub Actions; exits 1 if an execute failed or its wallet is low on ETH)
// Env: KEEPER_KEY, STAKE_CONTRACT, BASE_SEPOLIA_RPC (optional)
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config } from "../src/config.js";
import { logRanges, PARALLEL_CHUNKS } from "../src/x402/chain.js";

const ABI = parseAbi([
  "event SlashProposed(bytes32 indexed id, address indexed seller, address indexed buyer, uint256 amount, bytes32 evidence, uint8 kind, uint256 executeAfter)",
  "function claims(bytes32) view returns (address seller, address buyer, uint256 amount, uint256 executeAfter, uint8 status)",
  "function executeSlash(bytes32 id) returns (uint256 paid)",
]);
const PENDING = 1;
/** 6 hours of 2 s blocks: runs are 30 minutes apart, so this survives several missed runs. */
const LOOKBACK_BLOCKS = 10_800n;
const GRACE_S = 900n;
const LOW_ETH = 500_000_000_000_000n; // 0.0005 ETH

export interface KeeperChain {
  head(): Promise<{ number: bigint; timestamp: bigint }>;
  proposed(fromBlock: bigint, toBlock: bigint): Promise<Hex[]>;
  claim(id: Hex): Promise<{ executeAfter: bigint; status: number }>;
  execute(id: Hex): Promise<Hex>;
}

export function rpcKeeperChain(pub: PublicClient, key: Hex, contract: Hex, wallet = createWalletClient({ account: privateKeyToAccount(key), chain: baseSepolia, transport: http(config.rpcUrl) })): KeeperChain {
  return {
    async head() {
      const b = await pub.getBlock();
      return { number: b.number, timestamp: b.timestamp };
    },
    async proposed(fromBlock, toBlock) {
      const logs = await pub.getContractEvents({ address: contract, abi: ABI, eventName: "SlashProposed", fromBlock, toBlock });
      return logs.map((l) => l.args.id as Hex);
    },
    async claim(id) {
      const [, , , executeAfter, status] = await pub.readContract({ address: contract, abi: ABI, functionName: "claims", args: [id] });
      return { executeAfter, status };
    },
    async execute(id) {
      // Simulating first means a refund that cannot be paid costs no gas.
      const { request } = await pub.simulateContract({ account: wallet.account!, address: contract, abi: ABI, functionName: "executeSlash", args: [id] });
      const hash = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status !== "success") throw new Error(`executeSlash reverted (tx ${hash})`);
      return hash;
    },
  };
}

export async function runKeeper(o: { chain: KeeperChain; lookback?: bigint; grace?: bigint; log?: (line: string) => void }) {
  const log = o.log ?? ((line: string) => console.log(`[keeper] ${line}`));
  const lookback = o.lookback ?? LOOKBACK_BLOCKS;
  const grace = o.grace ?? GRACE_S;
  const head = await o.chain.head();
  const start = head.number > lookback ? head.number - lookback : 0n;

  const ranges = logRanges(start, head.number);
  const ids = new Set<Hex>();
  for (let i = 0; i < ranges.length; i += PARALLEL_CHUNKS) {
    const batch = await Promise.all(ranges.slice(i, i + PARALLEL_CHUNKS).map(([from, to]) => o.chain.proposed(from, to)));
    for (const id of batch.flat()) ids.add(id);
  }

  const out = { found: ids.size, executed: 0, waiting: 0, failed: 0 };
  for (const id of ids) {
    const c = await o.chain.claim(id);
    if (c.status !== PENDING) continue;
    if (head.timestamp < c.executeAfter + grace) {
      out.waiting++;
      continue;
    }
    try {
      log(`claim ${id}: executed, tx ${await o.chain.execute(id)}`);
      out.executed++;
    } catch (err: any) {
      // The usual cause is a buyer USDC refuses. docs/STAKE.md has the runbook for that stuck claim.
      out.failed++;
      log(`claim ${id}: ${String(err?.shortMessage ?? err?.message ?? err).split("\n")[0]}`);
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.KEEPER_KEY as Hex | undefined;
  const contract = config.stake.contract;
  if (!key || !contract) {
    console.error("Set KEEPER_KEY and STAKE_CONTRACT (see .env.example).");
    process.exit(1);
  }
  const pub = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) }) as PublicClient;
  const r = await runKeeper({ chain: rpcKeeperChain(pub, key, contract) });
  console.log(`[keeper] pass done: ${r.found} recent claims, executed ${r.executed}, waiting ${r.waiting}, failed ${r.failed}`);
  const me = privateKeyToAccount(key).address;
  const eth = await pub.getBalance({ address: me });
  const low = eth < LOW_ETH;
  if (low) console.error(`[keeper] ${me} holds only ${formatEther(eth)} ETH: refill it`);
  process.exit(r.failed || low ? 1 : 0);
}
