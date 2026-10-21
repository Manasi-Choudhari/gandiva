import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/** Set by the UI's proxy (client/proxy.ts) on every API call it forwards: the shared secret and the visitor's IP. */
export const PROXY_HEADER = "x-gandiva-proxy";
export const PROXY_CLIENT_IP_HEADER = "x-gandiva-client-ip";

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Who is calling, for rate limits. Calls through the UI all arrive from Vercel's addresses, so the UI's proxy names the
 * visitor in a header, trusted only next to the right PROXY_SECRET. Direct calls on Render come through Cloudflare, which
 * overwrites CF-Connecting-IP with the caller's address; the last X-Forwarded-For entry there is Render's own internal
 * hop. Off Render a client could send that header itself, so it is ignored. Anything else is keyed by the right-most
 * X-Forwarded-For entry (the one our host's proxy added; the left ones are whatever the client sent), or the socket.
 */
export function clientIp(c: Context): string {
  const secret = config.proxySecret;
  const sent = c.req.header(PROXY_HEADER);
  if (secret && sent && sameSecret(sent, secret)) {
    const ip = c.req.header(PROXY_CLIENT_IP_HEADER)?.trim();
    if (ip && ip.length <= 64) return ip;
  }
  if (process.env.RENDER === "true") {
    const ip = c.req.header("cf-connecting-ip")?.trim();
    if (ip && ip.length <= 64) return ip;
  }
  const forwarded = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "direct";
  } catch {
    return "direct"; // app.request() in tests has no socket
  }
}
