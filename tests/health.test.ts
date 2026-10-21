import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { healthz } from "../src/http/health.js";
import { workerStatus, workerTick } from "../src/workers.js";

const app = () => new Hono().get("/healthz", healthz);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("/healthz", () => {
  it("answers 200 when the database does", async () => {
    const res = await app().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers 503 when the database can't, and logs why without telling the caller", async () => {
    vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await app().request("/healthz");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
    expect(JSON.parse(logged.mock.calls[0][0])).toMatchObject({ level: "error", msg: "healthz: database check failed", error: "database disk image is malformed" });
  });
});

describe("spend cap on /api/info", () => {
  it("is the cap when the key is fine or missing", async () => {
    const { spendCapStatus } = await import("../src/http/health.js");
    expect(spendCapStatus()).toMatchObject({ enabled: true, limitUsdc: "0.500000" });
  });

  it("is null with a malformed BUYER_PRIVATE_KEY instead of throwing", async () => {
    vi.stubEnv("BUYER_PRIVATE_KEY", "0xabc");
    vi.resetModules();
    const { spendCapStatus } = await import("../src/http/health.js");
    expect(spendCapStatus()).toBeNull();
  });
});

describe("worker ticks", () => {
  it("records each worker's last pass and how it went", () => {
    workerTick("resolver");
    workerTick("claims", false);
    const s = workerStatus();
    expect(s.resolver.ok).toBe(true);
    expect(s.claims.ok).toBe(false);
    expect(new Date(s.resolver.lastTick).toISOString()).toBe(s.resolver.lastTick);
  });

  it("a later good pass clears a failed one", () => {
    workerTick("resolver", false);
    workerTick("resolver");
    expect(workerStatus().resolver.ok).toBe(true);
  });
});
