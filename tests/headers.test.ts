import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { apiSecurityHeaders, privateNoStore } from "../src/http/headers.js";

const app = new Hono();
app.use("*", apiSecurityHeaders());
app.use("*", privateNoStore());
app.get("*", (c) => c.json({ ok: true }));

describe("API security headers", () => {
  it("adds browser hardening to every answer but leaves the public API embeddable cross-origin", async () => {
    const res = await app.request("/registry/services");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=/);
    expect(res.headers.get("cross-origin-resource-policy")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("marks signed-in answers no-store", async () => {
    for (const path of ["/agent", "/buyer/runs/x", "/auth/me", "/registry/mine/chains"]) {
      expect((await app.request(path)).headers.get("cache-control")).toBe("no-store");
    }
  });
});
