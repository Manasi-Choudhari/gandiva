import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { runKeeper, type KeeperChain } from "../scripts/keeper.js";

const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const NOW = 1_800_000_000n;

function fake(claims: Record<string, { block: bigint; executeAfter: bigint; status: number; refuse?: boolean }>, head = 100_000n) {
  const sent: Hex[] = [];
  const asked: [bigint, bigint][] = [];
  const chain: KeeperChain = {
    head: async () => ({ number: head, timestamp: NOW }),
    proposed: async (from, to) => {
      asked.push([from, to]);
      return (Object.keys(claims) as Hex[]).filter((k) => claims[k].block >= from && claims[k].block <= to);
    },
    claim: async (c) => claims[c],
    execute: async (c) => {
      if (claims[c].refuse) throw new Error("blocked\nmore detail");
      sent.push(c);
      return `0x${"aa".repeat(32)}`;
    },
  };
  return { chain, sent, asked };
}

describe("keeper", () => {
  const quiet = () => {};

  it("executes a claim past its window and the grace time, and nothing else", async () => {
    const { chain, sent } = fake({
      [id(1)]: { block: 99_000n, executeAfter: NOW - 1000n, status: 1 }, // overdue
      [id(2)]: { block: 99_500n, executeAfter: NOW - 100n, status: 1 }, // the server still has time
      [id(3)]: { block: 99_600n, executeAfter: NOW + 100n, status: 1 }, // inside the window
      [id(4)]: { block: 98_000n, executeAfter: NOW - 5000n, status: 2 }, // already executed
      [id(5)]: { block: 98_100n, executeAfter: NOW - 5000n, status: 3 }, // vetoed
    });
    expect(await runKeeper({ chain, log: quiet })).toEqual({ found: 5, executed: 1, waiting: 2, failed: 0 });
    expect(sent).toEqual([id(1)]);
  });

  it("keeps going past a refund that cannot be paid, and reports it", async () => {
    const lines: string[] = [];
    const { chain, sent } = fake({
      [id(1)]: { block: 99_000n, executeAfter: NOW - 1000n, status: 1, refuse: true },
      [id(2)]: { block: 99_100n, executeAfter: NOW - 1000n, status: 1 },
    });
    expect(await runKeeper({ chain, log: (l) => lines.push(l) })).toMatchObject({ executed: 1, failed: 1 });
    expect(sent).toEqual([id(2)]);
    expect(lines.join("\n")).toContain(`claim ${id(1)}: blocked`);
    expect(lines.join("\n")).not.toContain("more detail");
  });

  it("asks the RPC for ranges it accepts, with no gap and no block twice", async () => {
    const { chain, asked } = fake({}, 100_000n);
    await runKeeper({ chain, lookback: 1000n, log: quiet });
    const sorted = [...asked].sort(([a], [b]) => (a < b ? -1 : 1));
    expect(sorted[0][0]).toBe(99_000n);
    expect(sorted.at(-1)![1]).toBe(100_000n);
    for (const [i, [from, to]] of sorted.entries()) {
      expect(to - from).toBeLessThanOrEqual(200n); // sepolia.base.org refuses more
      if (i) expect(from).toBe(sorted[i - 1][1] + 1n);
    }
  });

  it("finds a claim at the first and last block of a range, once", async () => {
    const { chain, sent } = fake({
      [id(1)]: { block: 99_000n, executeAfter: NOW - 1000n, status: 1 },
      [id(2)]: { block: 100_000n, executeAfter: NOW - 1000n, status: 1 },
    });
    expect(await runKeeper({ chain, lookback: 1000n, log: quiet })).toMatchObject({ found: 2, executed: 2 });
    expect(sent).toHaveLength(2);
  });

  it("starts at block 0 on a chain younger than its lookback", async () => {
    const { chain, asked } = fake({}, 100n);
    await runKeeper({ chain, log: quiet });
    expect(asked.map(([from]) => from)).toContain(0n);
  });
});
