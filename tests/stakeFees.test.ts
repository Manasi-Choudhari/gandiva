import { describe, expect, it } from "vitest";
import { parseGwei } from "viem";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { overCeiling, signerChangesToday } from "../src/stake/index.js";
import { logRanges } from "../src/x402/chain.js";

// The relayer's gas ceiling and its per-seller limit. The fees themselves are contract rules: foundry/test and
// tests/sellerStakeV2.test.ts cover them, and npm run stake:dry-run covers the gates against a real chain.
describe("gas ceiling", () => {
  it("defaults to 0.02 gwei", () => {
    expect(config.stake.relayMaxGwei).toBe("0.02");
  });

  it("lets seller actions through up to the ceiling and not past it", () => {
    expect(overCeiling(parseGwei("0.006"), "0.02")).toBe(false);
    expect(overCeiling(parseGwei("0.02"), "0.02")).toBe(false);
    expect(overCeiling(parseGwei("0.02") + 1n, "0.02")).toBe(true);
    expect(overCeiling(parseGwei("0.05"), "0.02")).toBe(true);
  });

  it("refuses to send on a ceiling it cannot read", () => {
    expect(() => overCeiling(1n, "lots")).toThrow();
  });
});

describe("log ranges", () => {
  it("stays inside the 200 blocks sepolia.base.org allows, with no gap and no block twice", () => {
    const ranges = logRanges(1000n, 5000n);
    expect(ranges[0][0]).toBe(1000n);
    expect(ranges.at(-1)![1]).toBe(5000n);
    for (const [i, [from, to]] of ranges.entries()) {
      expect(to - from).toBeLessThanOrEqual(200n);
      if (i) expect(from).toBe(ranges[i - 1][1] + 1n);
    }
  });

  it("handles a single block, and nothing to scan", () => {
    expect(logRanges(7n, 7n)).toEqual([[7n, 7n]]);
    expect(logRanges(8n, 7n)).toEqual([]);
  });
});

describe("receipt signer changes", () => {
  const seller = "0x00000000000000000000000000000000000000Aa";
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  const add = (ts: string, status = "done", kind = "receipt-signer") =>
    db.prepare("INSERT INTO stake_events (ts,kind,seller,amount,status) VALUES (?,?,?,'0',?)").run(ts, kind, seller, status);

  it("counts the seller's finished changes in the last 24 h, in any address case", () => {
    db.exec("DELETE FROM stake_events");
    add("2026-10-31T11:00:00.000Z");
    add("2026-10-30T13:00:00.000Z");
    add("2026-10-30T11:00:00.000Z"); // over a day old
    add("2026-10-31T11:00:00.000Z", "failed");
    add("2026-10-31T11:00:00.000Z", "done", "stake");
    expect(signerChangesToday(seller, now)).toBe(2);
    expect(signerChangesToday(seller.toLowerCase(), now)).toBe(2);
  });
});
