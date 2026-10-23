import { createPublicClient, http, parseAbi, parseAbiItem, parseEventLogs, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { config, USDC_ADDRESS } from "../config.js";

const usdcAbi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const authorizationUsed = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

// sepolia.base.org rejects eth_getLogs ranges above ~200 blocks, so scan in smaller chunks.
export const LOG_CHUNK = 150n;
export const PARALLEL_CHUNKS = 8;
const BASE_BLOCK_SECONDS = 2;

/** `start` to `end` as block ranges an RPC accepts, oldest first, with no gap and no block twice. */
export function logRanges(start: bigint, end: bigint): [bigint, bigint][] {
  const ranges: [bigint, bigint][] = [];
  for (let from = start; from <= end; from += LOG_CHUNK + 1n) ranges.push([from, from + LOG_CHUNK < end ? from + LOG_CHUNK : end]);
  return ranges;
}

let client: PublicClient | null = null;
export const chainClient = (): PublicClient => (client ??= createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) }) as PublicClient);

export interface AuthRef {
  from: string;
  nonce: string;
  validBefore: number;
  signedAt: number;
}

export type AuthOutcome =
  | { state: "used"; txHash: string; amount: bigint; to: string }
  | { state: "used_tx_unknown" }
  | { state: "unused"; expired: boolean };

/** Latest block timestamp in seconds; the authorization's validBefore is judged against chain time, not our clock. */
export async function chainTime(): Promise<number> {
  const block = await chainClient().getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}

/**
 * Did this EIP-3009 authorisation move money? USDC records every consumed nonce, so `authorizationState` is a definitive answer.
 * If it was consumed we also look up the AuthorizationUsed event to find the settlement tx and the amount transferred.
 */
export async function lookupAuthorization(a: AuthRef, now?: number): Promise<AuthOutcome> {
  const c = chainClient();
  const used = await c.readContract({ address: USDC_ADDRESS, abi: usdcAbi, functionName: "authorizationState", args: [a.from as `0x${string}`, a.nonce as `0x${string}`] });
  if (!used) {
    const t = now ?? (await chainTime());
    return { state: "unused", expired: t > a.validBefore };
  }

  const latest = await c.getBlockNumber();
  // Start a little before the estimated block of signing, then scan forward in RPC-sized chunks.
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - a.signedAt);
  const start = latest - BigInt(Math.ceil(ageSeconds / BASE_BLOCK_SECONDS) + 300);
  const ranges: [bigint, bigint][] = [];
  for (let to = latest; to >= start; to -= LOG_CHUNK + 1n) ranges.push([to - LOG_CHUNK > start ? to - LOG_CHUNK : start, to]);
  for (let i = 0; i < ranges.length; i += PARALLEL_CHUNKS) {
    const batch = await Promise.all(
      ranges.slice(i, i + PARALLEL_CHUNKS).map(([fromBlock, toBlock]) =>
        c.getLogs({ address: USDC_ADDRESS, event: authorizationUsed, args: { authorizer: a.from as `0x${string}`, nonce: a.nonce as `0x${string}` }, fromBlock, toBlock }),
      ),
    );
    const hit = batch.flat()[0];
    if (!hit) continue;
    const receipt = await c.getTransactionReceipt({ hash: hit.transactionHash });
    const transfer = parseEventLogs({ abi: usdcAbi, eventName: "Transfer", logs: receipt.logs }).find(
      (l) => l.address.toLowerCase() === USDC_ADDRESS.toLowerCase() && l.args.from.toLowerCase() === a.from.toLowerCase(),
    );
    if (transfer) return { state: "used", txHash: hit.transactionHash, amount: transfer.args.value, to: transfer.args.to };
  }
  return { state: "used_tx_unknown" };
}
