import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MAX_REQUEST_BYTES, requestSizeLimit } from "../src/http/bodyLimit.js";

// Like paidRoute, the handler reads the raw text itself.
const app = new Hono();
app.use("*", requestSizeLimit());
app.post("*", async (c) => c.json({ bytes: (await c.req.text()).length }));
app.get("*", (c) => c.text("ok"));

const streamed = (bytes: number) =>
  new ReadableStream({
    start(ctl) {
      for (let left = bytes; left > 0; left -= 16_384) ctl.enqueue(new Uint8Array(Math.min(16_384, left)).fill(97));
      ctl.close();
    },
  });

describe("requestSizeLimit", () => {
  it("passes a body at the limit through to the handler intact", async () => {
    const res = await app.request("/sellers/x", { method: "POST", body: "a".repeat(MAX_REQUEST_BYTES) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: MAX_REQUEST_BYTES });
  });

  it("answers 413 for a bigger body by its Content-Length", async () => {
    const res = await app.request("/sellers/x", { method: "POST", body: "a".repeat(MAX_REQUEST_BYTES + 1) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/request too large/);
  });

  it("answers 413 for a streamed body with no Content-Length once it passes the limit", async () => {
    const res = await app.request("/mcp", { method: "POST", body: streamed(MAX_REQUEST_BYTES + 1), duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("leaves requests without a body alone", async () => {
    expect((await app.request("/registry/services")).status).toBe(200);
  });
});
