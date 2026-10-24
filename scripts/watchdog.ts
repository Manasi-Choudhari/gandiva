// Checks the live system from outside and exits 1 on any problem, so a scheduled GitHub run fails and GitHub emails the owner.
// It only reads, and holds no key.
// Usage: npm run watchdog
// Env: GANDIVA_URL, STAKE_CONTRACT (optional: without it only the API is checked), BASE_SEPOLIA_RPC (optional)
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { createPublicClient, erc20Abi, http, parseAbi, type Hex, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { config, USDC_ADDRESS } from "../src/config.js";

/** A healthy claim is closed within about this long: 1 hour to go on chain at the very most, then the 30 minute window. */
const STUCK_MINUTES = 100;
/** A worker runs at least this often, so an older last pass means it has stalled. */
const STALE_MINUTES = 10;
/** Too few transactions say nothing: fees arrive at staking, and rotations earn none. */
const MIN_TXS_FOR_COVER = 20;
const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as const; // Chainlink on Base mainnet, read only for the price

export interface WatchdogChain {
  /** USDC the contract holds, and what it owes in bonds. */
  bonds(): Promise<{ held: bigint; owed: bigint }>;
  /** Null when the price cannot be read; the fee check is then skipped. */
  ethUsd(): Promise<number | null>;
}

export function rpcWatchdogChain(pub: PublicClient, contract: Hex): WatchdogChain {
  const prices = createPublicClient({ chain: base, transport: http() });
  return {
    async bonds() {
      const [held, owed] = await Promise.all([
        pub.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [contract] }),
        pub.readContract({ address: contract, abi: parseAbi(["function totalStaked() view returns (uint256)"]), functionName: "totalStaked" }),
      ]);
      return { held, owed };
    },
    async ethUsd() {
      const answer = await prices.readContract({ address: ETH_USD_FEED, abi: parseAbi(["function latestAnswer() view returns (int256)"]), functionName: "latestAnswer" }).catch(() => null);
      return answer === null ? null : Number(answer) / 1e8;
    },
  };
}

/** Render's free tier can take about a minute to wake, so a slow first answer is not a failure. */
async function getJson(url: string, tries = 3, wait = 20_000): Promise<any> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Returns every problem found; an empty list means healthy. */
export async function runWatchdog(o: { url: string; contract?: string; chain?: WatchdogChain; tries?: number; wait?: number; now?: number }): Promise<string[]> {
  const now = o.now ?? Date.now();
  const get = (path: string) => getJson(o.url + path, o.tries, o.wait);
  const problems: string[] = [];

  try {
    const health = await get("/healthz");
    if (health.ok !== true) problems.push("/healthz says the API is not healthy");
  } catch (err: any) {
    return [`the API does not answer at ${o.url}: ${err?.message ?? err}`]; // the rest would all fail for the same reason
  }

  const info = await get("/api/info").catch((err) => (problems.push(`/api/info failed: ${err?.message ?? err}`), null));
  for (const [name, w] of Object.entries((info?.workers ?? {}) as Record<string, { lastTick: string; ok: boolean }>)) {
    const age = (now - Date.parse(w.lastTick)) / 60_000;
    if (age > STALE_MINUTES) problems.push(`the ${name} worker last ran ${Math.round(age)} minutes ago`);
    else if (!w.ok) problems.push(`the ${name} worker's last pass failed`);
  }

  if (!o.contract) return problems;

  const stake = await get("/registry/stake").catch((err) => (problems.push(`/registry/stake failed: ${err?.message ?? err}`), null));
  if (stake) {
    if (!stake.enabled) problems.push("staking is off on the server");
    else {
      if (stake.contract?.toLowerCase() !== o.contract.toLowerCase()) problems.push(`the server uses contract ${stake.contract}, not ${o.contract}`);
      if (stake.relayer?.low) problems.push(`the relayer ${stake.relayer.address} is low on ETH (${stake.relayer.eth}): stakes and refunds stop when it runs out`);
      if ((stake.claims?.oldestOpenMinutes ?? 0) > STUCK_MINUTES) problems.push(`a claim has been open for ${stake.claims.oldestOpenMinutes} minutes: see docs/STAKE.md, A stuck claim`);
      if (o.chain && (stake.relayer?.txs ?? 0) >= MIN_TXS_FOR_COVER) {
        const price = await o.chain.ethUsd();
        const spent = Number(stake.relayer.gasEth) * (price ?? 0);
        const earned = Number(stake.relayer.feesUsdc);
        if (price !== null && spent > earned) problems.push(`the relayer has spent about $${spent.toFixed(4)} of gas and earned ${earned} USDC: the fees no longer cover it`);
      }
    }
  }

  if (o.chain) {
    try {
      const { held, owed } = await o.chain.bonds();
      if (held < owed) problems.push(`the contract holds ${held} USDC units but owes ${owed} in bonds`);
    } catch (err: any) {
      problems.push(`could not read the contract: ${err?.shortMessage ?? err?.message ?? err}`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.GANDIVA_URL;
  if (!url) {
    console.error("Set GANDIVA_URL (see .env.example).");
    process.exit(1);
  }
  const contract = config.stake.contract;
  const pub = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) }) as PublicClient;
  const problems = await runWatchdog({ url, contract, chain: contract ? rpcWatchdogChain(pub, contract) : undefined });
  for (const p of problems) console.error(`[watchdog] ${p}`);
  console.log(`[watchdog] ${problems.length ? `${problems.length} problem(s)` : "healthy"}`);
  process.exit(problems.length ? 1 : 0);
}
