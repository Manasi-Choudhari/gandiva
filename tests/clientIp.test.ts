import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { clientIp } from "../src/http/clientIp.js";

const app = new Hono().get("/", (c) => c.text(clientIp(c)));
const ip = async (headers: Record<string, string>) => (await app.request("/", { headers })).text();

describe("clientIp", () => {
  afterEach(() => {
    delete process.env.PROXY_SECRET;
    delete process.env.RENDER;
  });

  it("trusts the UI proxy's visitor IP only next to the right secret", async () => {
    process.env.PROXY_SECRET = "s3cret-value";
    expect(await ip({ "x-gandiva-proxy": "s3cret-value", "x-gandiva-client-ip": "203.0.113.7", "x-forwarded-for": "76.76.21.1" })).toBe("203.0.113.7");
    expect(await ip({ "x-gandiva-proxy": "wrong", "x-gandiva-client-ip": "203.0.113.7", "x-forwarded-for": "76.76.21.1" })).toBe("76.76.21.1");
    expect(await ip({ "x-gandiva-proxy": "s3cret-valu", "x-gandiva-client-ip": "203.0.113.7", "x-forwarded-for": "76.76.21.1" })).toBe("76.76.21.1");
  });

  it("never trusts the visitor header while PROXY_SECRET is unset", async () => {
    expect(await ip({ "x-gandiva-proxy": "", "x-gandiva-client-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.2" })).toBe("198.51.100.2");
  });

  it("uses the right-most X-Forwarded-For entry, since the left ones come from the client", async () => {
    expect(await ip({ "x-forwarded-for": "1.2.3.4, 198.51.100.9" })).toBe("198.51.100.9");
  });

  it("on Render, uses Cloudflare's address for direct calls instead of Render's internal hop", async () => {
    process.env.RENDER = "true";
    expect(await ip({ "cf-connecting-ip": "203.0.113.50", "x-forwarded-for": "203.0.113.50, 10.195.69.165" })).toBe("203.0.113.50");
    expect(await ip({ "cf-connecting-ip": "2001:db8::50", "x-forwarded-for": "2001:db8::50, 10.195.69.165" })).toBe("2001:db8::50");
  });

  it("on Render, the UI proxy's visitor IP still wins over Cloudflare's address for Vercel", async () => {
    process.env.RENDER = "true";
    process.env.PROXY_SECRET = "s3cret-value";
    expect(await ip({ "x-gandiva-proxy": "s3cret-value", "x-gandiva-client-ip": "203.0.113.7", "cf-connecting-ip": "76.76.21.1" })).toBe("203.0.113.7");
    expect(await ip({ "x-gandiva-proxy": "wrong", "x-gandiva-client-ip": "203.0.113.7", "cf-connecting-ip": "76.76.21.1" })).toBe("76.76.21.1");
  });

  it("on Render, falls back to X-Forwarded-For when Cloudflare's header is missing or empty", async () => {
    process.env.RENDER = "true";
    expect(await ip({ "x-forwarded-for": "198.51.100.9" })).toBe("198.51.100.9");
    expect(await ip({ "cf-connecting-ip": " ", "x-forwarded-for": "198.51.100.9" })).toBe("198.51.100.9");
  });

  it("ignores Cloudflare's header off Render, where a client could fake it to dodge the limits", async () => {
    expect(await ip({ "cf-connecting-ip": "127.0.0.1", "x-forwarded-for": "198.51.100.9" })).toBe("198.51.100.9");
    process.env.RENDER = "false";
    expect(await ip({ "cf-connecting-ip": "127.0.0.1", "x-forwarded-for": "198.51.100.9" })).toBe("198.51.100.9");
  });

  it("falls back when there is no header and no socket", async () => {
    expect(await ip({})).toBe("direct");
  });
});
