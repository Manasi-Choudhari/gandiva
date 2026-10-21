import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onServerError, requestIds, requestLog } from "../src/http/requestLog.js";
import { log } from "../src/log.js";

let lines: { level: string; line: string }[];
const entries = () => lines.map((l) => ({ ...JSON.parse(l.line), stream: l.level }));

beforeEach(() => {
  lines = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: string) => void lines.push({ level, line }));
  }
});
afterEach(() => vi.restoreAllMocks());

function app() {
  const a = new Hono();
  a.use("*", requestIds());
  a.use("*", requestLog());
  a.onError(onServerError);
  a.post("/pay", (c) => c.json({ ok: true }));
  a.get("/healthz", (c) => c.json({ ok: true }));
  a.get("/down", (c) => c.json({ ok: false }, 503));
  a.get("/boom", () => {
    throw new Error("rpc refused the key material");
  });
  return a;
}

describe("log", () => {
  it("writes one JSON line with the time, level, message and fields", () => {
    log("info", "settled", { paid: 2 });
    const [e] = entries();
    expect(e).toMatchObject({ level: "info", msg: "settled", paid: 2, stream: "log" });
    expect(new Date(e.ts).toISOString()).toBe(e.ts);
    expect(lines[0].line).not.toContain("\n");
  });

  it("sends warnings and errors to their own streams", () => {
    log("warn", "low");
    log("error", "broken");
    expect(entries().map((e) => e.stream)).toEqual(["warn", "error"]);
  });

  it("survives a bigint, which plain JSON.stringify would throw on", () => {
    log("info", "amount", { paid: 3000n });
    expect(entries()[0].paid).toBe("3000");
  });
});

describe("request log", () => {
  it("records the method, path, status, time, ip and request id", async () => {
    const res = await app().request("/pay", { method: "POST", headers: { "x-forwarded-for": "198.51.100.7" } });
    const e = entries()[0];
    expect(e).toMatchObject({ level: "info", msg: "request", method: "POST", path: "/pay", status: 200, ip: "198.51.100.7" });
    expect(e.ms).toBeGreaterThanOrEqual(0);
    expect(e.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("never logs headers, the body or the query string", async () => {
    await app().request("/pay?token=query-secret", {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": "sig-secret", cookie: "session=cookie-secret", authorization: "Bearer auth-secret" },
      body: JSON.stringify({ apiKey: "body-secret" }),
    });
    const out = lines.map((l) => l.line).join("\n");
    expect(out).toContain("/pay");
    expect(out).not.toMatch(/secret/);
  });

  it("keeps a plain client request id and replaces one that could forge a line", async () => {
    const kept = await app().request("/healthz", { headers: { "x-request-id": "trace-123" } });
    expect(kept.headers.get("x-request-id")).toBe("trace-123");
    const replaced = await app().request("/healthz", { headers: { "x-request-id": 'a"},{"level":"error' } });
    expect(replaced.headers.get("x-request-id")).not.toContain('"');
    const long = await app().request("/healthz", { headers: { "x-request-id": "a".repeat(65) } });
    expect(long.headers.get("x-request-id")).toHaveLength(36);
  });

  it("stays quiet about a healthy /healthz", async () => {
    await app().request("/healthz");
    expect(lines).toEqual([]);
  });

  it("logs a server-side failure as an error", async () => {
    await app().request("/down");
    expect(entries()[0]).toMatchObject({ level: "error", status: 503, path: "/down" });
  });

  it("logs an unhealthy /healthz", async () => {
    const a = new Hono();
    a.use("*", requestIds());
    a.use("*", requestLog());
    a.get("/healthz", (c) => c.json({ ok: false }, 503));
    await a.request("/healthz");
    expect(entries()[0]).toMatchObject({ level: "error", status: 503, path: "/healthz" });
  });
});

describe("unhandled errors", () => {
  it("gives the caller a request id and keeps the real error in the log", async () => {
    const res = await app().request("/boom");
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "internal error", requestId: res.headers.get("x-request-id") });
    expect(JSON.stringify(body)).not.toContain("rpc refused");
    const e = entries().find((x) => x.msg === "unhandled error");
    expect(e).toMatchObject({ level: "error", path: "/boom", requestId: body.requestId, error: "rpc refused the key material" });
  });
});
