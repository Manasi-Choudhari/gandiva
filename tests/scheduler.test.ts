import { describe, expect, it } from "vitest";
import { PaymentScheduler, type CallRequest } from "../src/x402/scheduler.js";

const req = (o: Partial<CallRequest> = {}): CallRequest => ({
  wallet: "w1",
  sellerId: "s1",
  sellerName: "seller",
  price: 1_000n,
  budget: 50_000n,
  spent: 0n,
  reputation: 1,
  ...o,
});

describe("PaymentScheduler", () => {
  it("starts calls immediately while slots are free", async () => {
    const s = new PaymentScheduler(2, 2, 30_000, () => 0);
    const a = await s.acquire(req());
    const b = await s.acquire(req());
    expect(a.waitedMs).toBe(0);
    expect(b.beat).toEqual([]);
  });

  it("gives a freed slot to the highest-priority waiting call, not the first to arrive", async () => {
    let t = 0;
    const s = new PaymentScheduler(1, 5, 30_000, () => t);
    const busy = await s.acquire(req());
    const order: string[] = [];
    const low = s.acquire(req({ step: "low", reputation: 0.2, price: 90_000n })).then((x) => (order.push("low"), x));
    const high = s.acquire(req({ step: "high", reputation: 1, price: 1_000n, spent: 40_000n })).then((x) => (order.push("high"), x));
    busy.release();
    const first = await high;
    expect(first.beat.some((l) => l.includes("low"))).toBe(true);
    first.release();
    (await low).release();
    expect(order).toEqual(["high", "low"]);
    expect(s.status().contention[0].winner.label).toContain("high");
  });

  it("puts a settlement retry first", async () => {
    const s = new PaymentScheduler(1, 5);
    const busy = await s.acquire(req());
    const normal = s.acquire(req({ step: "normal", spent: 49_000n }));
    const retry = s.acquire(req({ step: "retry", retry: true, reputation: 0.5 }));
    busy.release();
    const won = await Promise.race([normal.then(() => "normal"), retry.then(() => "retry")]);
    expect(won).toBe("retry");
  });

  it("keeps arrival order when priorities are equal", async () => {
    const s = new PaymentScheduler(1, 5);
    const busy = await s.acquire(req());
    const order: number[] = [];
    const p1 = s.acquire(req()).then((x) => (order.push(1), x.release()));
    const p2 = s.acquire(req()).then((x) => (order.push(2), x.release()));
    busy.release();
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("limits calls per seller across wallets but lets another seller through", async () => {
    const s = new PaymentScheduler(5, 1);
    await s.acquire(req({ wallet: "a" }));
    let blocked = false;
    void s.acquire(req({ wallet: "b" })).then(() => (blocked = true));
    const other = await s.acquire(req({ wallet: "b", sellerId: "s2" }));
    expect(other.waitedMs).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(blocked).toBe(false);
  });

  it("ageing lets a long-waiting call overtake a newer, otherwise better one", () => {
    const s = new PaymentScheduler();
    const old = s.priority(s.factors(req({ reputation: 0.3 }), 10_000));
    const fresh = s.priority(s.factors(req({ reputation: 1 }), 0));
    expect(old).toBeGreaterThan(fresh);
  });

  it("starts a call that waited past maxWait even without a free slot (no deadlock)", async () => {
    let t = 0;
    const s = new PaymentScheduler(1, 1, 5_000, () => t);
    await s.acquire(req());
    const waiting = s.acquire(req({ step: "nested" }));
    t = 6_000;
    // The scheduler re-checks every second while anything waits.
    const slot = await waiting;
    expect(slot.forced).toBe(true);
    slot.release();
  });
});
