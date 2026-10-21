import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { rateGroup, rateLimit } from "../src/http/rateLimit.js";

function app(limits = {}) {
  let t = 1_000_000;
  const a = new Hono();
  a.use("*", rateLimit({ limits, now: () => t }));
  a.all("*", (c) => c.text("ok"));
  return { a, advance: (ms: number) => (t += ms) };
}
const hit = (a: Hono, path: string, init: RequestInit & { ip?: string } = {}) =>
  a.request(path, { ...init, headers: { "x-forwarded-for": init.ip ?? "198.51.100.1", ...(init.headers as Record<string, string>) } });

describe("rateGroup", () => {
  it("sorts routes into their groups", () => {
    expect(rateGroup("GET", "/auth/challenge", false)).toBe("auth");
    expect(rateGroup("POST", "/auth/login", false)).toBe("auth");
    expect(rateGroup("POST", "/buyer/run", false)).toBe("spend");
    expect(rateGroup("POST", "/buyer/call", false)).toBe("spend");
    expect(rateGroup("GET", "/buyer/runs/abc", false)).toBe("read");
    expect(rateGroup("POST", "/registry/services", false)).toBe("write");
    expect(rateGroup("DELETE", "/agent/llm", false)).toBe("write");
    expect(rateGroup("GET", "/sellers/fx-rates/rate", false)).toBe("x402");
    expect(rateGroup("POST", "/mcp", false)).toBe("x402");
    expect(rateGroup("GET", "/sellers/fx-rates/rate", true)).toBeNull();
    expect(rateGroup("OPTIONS", "/buyer/run", false)).toBeNull();
  });
});

describe("rateLimit", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT;
  });

  it("answers 429 with Retry-After past the limit, per IP, until the minute is over", async () => {
    const { a, advance } = app({ auth: 2 });
    expect((await hit(a, "/auth/challenge")).status).toBe(200);
    expect((await hit(a, "/auth/challenge")).status).toBe(200);
    const blocked = await hit(a, "/auth/challenge");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect((await hit(a, "/auth/challenge", { ip: "198.51.100.2" })).status).toBe(200);
    advance(60_000);
    expect((await hit(a, "/auth/challenge")).status).toBe(200);
  });

  it("counts each group separately", async () => {
    const { a } = app({ spend: 1 });
    expect((await hit(a, "/buyer/run", { method: "POST" })).status).toBe(200);
    expect((await hit(a, "/buyer/run", { method: "POST" })).status).toBe(429);
    expect((await hit(a, "/buyer/runs/x")).status).toBe(200);
  });

  it("never limits paid x402 calls, this machine or a server with RATE_LIMIT=off", async () => {
    const { a } = app({ x402: 0, auth: 0 });
    expect((await hit(a, "/sellers/fx/rate")).status).toBe(429);
    expect((await hit(a, "/sellers/fx/rate", { headers: { "PAYMENT-SIGNATURE": "abc" } })).status).toBe(200);
    expect((await hit(a, "/auth/login", { method: "POST", ip: "127.0.0.1" })).status).toBe(200);
    process.env.RATE_LIMIT = "off";
    expect((await hit(a, "/auth/login", { method: "POST" })).status).toBe(200);
  });
});
