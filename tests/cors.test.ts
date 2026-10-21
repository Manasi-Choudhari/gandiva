import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { corsPolicy, isSignedInPath, sameSiteWrites } from "../src/http/cors.js";

const SITE = "http://localhost:3001";
const EVIL = "https://evil.example";

const app = new Hono();
app.use("*", corsPolicy());
app.use("*", sameSiteWrites());
app.all("*", (c) => c.text("ok"));

const req = (path: string, init: { method?: string; origin?: string; cookie?: boolean; fetchSite?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin) headers.origin = init.origin;
  if (init.cookie) headers.cookie = "gandiva_session=abc";
  if (init.fetchSite) headers["sec-fetch-site"] = init.fetchSite;
  return app.request(path, { method: init.method ?? "GET", headers });
};

describe("corsPolicy", () => {
  it("knows which routes act for the signed-in user", () => {
    for (const p of ["/auth/login", "/agent", "/agent/withdraw", "/buyer/run", "/registry/mine", "/registry/mine/chains"]) expect(isSignedInPath(p)).toBe(true);
    for (const p of ["/sellers/fx/rate", "/mcp", "/registry/services", "/registry/ledger", "/api/info", "/healthz", "/agents", "/registry/minefield"]) expect(isSignedInPath(p)).toBe(false);
  });

  it("lets any site call the public marketplace", async () => {
    const res = await req("/registry/services", { origin: EVIL });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toContain("PAYMENT-REQUIRED");
  });

  it("allows only the site's own origins on signed-in routes", async () => {
    expect((await req("/agent", { origin: SITE })).headers.get("access-control-allow-origin")).toBe(SITE);
    expect((await req("/agent", { origin: EVIL })).headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await req("/buyer/run", { method: "OPTIONS", origin: EVIL });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("sameSiteWrites", () => {
  it("refuses a cookie-carrying write from another site, a null origin or a cross-site fetch", async () => {
    expect((await req("/agent/withdraw", { method: "POST", origin: EVIL, cookie: true })).status).toBe(403);
    expect((await req("/registry/mine/chains", { method: "DELETE", origin: "null", cookie: true })).status).toBe(403);
    expect((await req("/agent/llm", { method: "PUT", cookie: true, fetchSite: "cross-site" })).status).toBe(403);
  });

  it("accepts the site's own writes, cookie-less writes and reads", async () => {
    expect((await req("/agent/withdraw", { method: "POST", origin: SITE, cookie: true, fetchSite: "same-origin" })).status).toBe(200);
    expect((await req("/agent/withdraw", { method: "POST", cookie: true })).status).toBe(200); // no Origin: not a browser page
    expect((await req("/registry/services", { method: "POST", origin: EVIL })).status).toBe(200); // no cookie: open listing
    expect((await req("/agent", { origin: EVIL, cookie: true })).status).toBe(200);
  });
});
