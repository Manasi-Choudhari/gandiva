import { afterEach, describe, expect, it, vi } from "vitest";
import { runWatchdog, type WatchdogChain } from "../scripts/watchdog.js";

const URL_ = "http://api";
const CONTRACT = "0x00000000000000000000000000000000000057a4";
const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const fresh = { lastTick: "2026-10-31T11:58:00.000Z", ok: true };
const healthyStake = () => ({
  enabled: true,
  contract: CONTRACT,
  relayer: { address: "0xabc", eth: "0.01", low: false, txs: 30, gasEth: "0.00001", feesUsdc: "0.500000" },
  claims: { open: 0, oldestOpenMinutes: null },
});

function api(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const body = routes[url.replace(URL_, "")];
    if (body === undefined) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}
const chain = (o: Partial<{ held: bigint; owed: bigint; price: number | null }> = {}): WatchdogChain => ({
  bonds: async () => ({ held: o.held ?? 100n, owed: o.owed ?? 100n }),
  ethUsd: async () => (o.price === undefined ? 2240 : o.price),
});
const run = (o: { contract?: string; chain?: WatchdogChain } = {}) => runWatchdog({ url: URL_, contract: CONTRACT, chain: chain(), tries: 1, wait: 0, now: NOW, ...o });
const healthy = (over: Record<string, unknown> = {}) => ({ "/healthz": { ok: true }, "/api/info": { workers: { claims: fresh, resolver: fresh } }, "/registry/stake": healthyStake(), ...over });

afterEach(() => vi.unstubAllGlobals());

describe("watchdog", () => {
  it("is quiet when everything is fine", async () => {
    api(healthy());
    expect(await run()).toEqual([]);
  });

  it("reports an API that does not answer, once", async () => {
    api({});
    const problems = await run();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not answer/);
  });

  it("waits out a slow wake-up", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/healthz") && ++calls < 3) throw new Error("timed out");
      return new Response(JSON.stringify(healthy()[url.replace(URL_, "") as keyof ReturnType<typeof healthy>]), { status: 200 });
    });
    expect(await runWatchdog({ url: URL_, contract: CONTRACT, chain: chain(), tries: 3, wait: 0, now: NOW })).toEqual([]);
    expect(calls).toBe(3);
  });

  it("checks only the API while no contract is set", async () => {
    api({ "/healthz": { ok: true }, "/api/info": { workers: {} } });
    expect(await run({ contract: "", chain: undefined })).toEqual([]);
  });

  it("flags a stalled worker and a failed pass", async () => {
    api(healthy({ "/api/info": { workers: { claims: { lastTick: "2026-10-31T11:00:00.000Z", ok: true }, resolver: { ...fresh, ok: false } } } }));
    expect(await run()).toEqual(["the claims worker last ran 60 minutes ago", "the resolver worker's last pass failed"]);
  });

  it("flags staking switched off, or pointed at another contract", async () => {
    api(healthy({ "/registry/stake": { enabled: false } }));
    expect(await run()).toEqual(["staking is off on the server"]);
    api(healthy({ "/registry/stake": { ...healthyStake(), contract: "0x1111111111111111111111111111111111111111" } }));
    expect((await run())[0]).toMatch(/not 0x/);
  });

  it("flags a relayer low on ETH", async () => {
    const s = healthyStake();
    api(healthy({ "/registry/stake": { ...s, relayer: { ...s.relayer, low: true } } }));
    expect((await run())[0]).toMatch(/low on ETH/);
  });

  it("flags a stuck claim, but not one inside the normal time", async () => {
    api(healthy({ "/registry/stake": { ...healthyStake(), claims: { open: 1, oldestOpenMinutes: 95 } } }));
    expect(await run()).toEqual([]);
    api(healthy({ "/registry/stake": { ...healthyStake(), claims: { open: 1, oldestOpenMinutes: 101 } } }));
    expect((await run())[0]).toMatch(/open for 101 minutes/);
  });

  it("flags fees that no longer cover the gas, with enough transactions to tell", async () => {
    const s = healthyStake();
    const costly = { ...s.relayer, gasEth: "0.001", feesUsdc: "1.000000" }; // about $2.24 spent
    api(healthy({ "/registry/stake": { ...s, relayer: costly } }));
    expect((await run())[0]).toMatch(/no longer cover/);
    api(healthy({ "/registry/stake": { ...s, relayer: { ...costly, txs: 19 } } }));
    expect(await run()).toEqual([]);
  });

  it("skips the fee check when the price cannot be read", async () => {
    const s = healthyStake();
    api(healthy({ "/registry/stake": { ...s, relayer: { ...s.relayer, gasEth: "0.001", feesUsdc: "1.000000" } } }));
    expect(await run({ chain: chain({ price: null }) })).toEqual([]);
  });

  it("flags a contract holding less than it owes, and a chain it cannot read", async () => {
    api(healthy());
    expect(await run({ chain: chain({ held: 99n, owed: 100n }) })).toEqual(["the contract holds 99 USDC units but owes 100 in bonds"]);
    const broken: WatchdogChain = { bonds: async () => Promise.reject(new Error("rpc down")), ethUsd: async () => null };
    expect(await run({ chain: broken })).toEqual(["could not read the contract: rpc down"]);
  });

  it("does not mind extra USDC sent to the contract", async () => {
    api(healthy());
    expect(await run({ chain: chain({ held: 150n, owed: 100n }) })).toEqual([]);
  });
});
