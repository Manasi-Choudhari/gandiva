import type { Context, MiddlewareHandler } from "hono";
import { clientIp } from "./clientIp.js";

/** Requests per client IP per minute, by kind of route. The routes keep their own, tighter per-feature limits on top. */
export const RATE_LIMITS = {
  // Sign-in codes come from a shared pool, so a flood could block everyone's sign-in.
  auth: 10,
  // Starts paid work: a run, a direct buy or call.
  spend: 10,
  // Any other write: Sell-tab listings, agent wallet, registry.
  write: 30,
  // Unpaid hits on the x402 endpoints (402 challenges, MCP handshakes). Paid ones carry a fresh signed authorisation each.
  x402: 300,
  // Everything else; an open Run page polls about 130 times a minute.
  read: 600,
} as const;
export type RateGroup = keyof typeof RATE_LIMITS;

const WINDOW_MS = 60_000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const READ_METHODS = new Set(["GET", "HEAD"]);

export function rateGroup(method: string, path: string, paid: boolean): RateGroup | null {
  if (method === "OPTIONS") return null; // CORS preflight
  if (/^\/auth\/(challenge|login|nonce)$/.test(path)) return "auth";
  if (/^\/(sellers\/|mcp$)/.test(path)) return paid ? null : "x402";
  if (method === "POST" && /^\/buyer\/(run|buy|call)$/.test(path)) return "spend";
  return READ_METHODS.has(method) ? "read" : "write";
}

/**
 * Fixed one-minute windows per client IP and group, in memory. Calls from this machine (local dev, judge scripts,
 * seller processes) are never limited. RATE_LIMIT=off turns it off.
 * shortcut: per process, like the other counters; it would move to the database if the API ever ran as several instances.
 */
export function rateLimit(opts: { limits?: Partial<Record<RateGroup, number>>; now?: () => number } = {}): MiddlewareHandler {
  const limits = { ...RATE_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();

  return async (c: Context, next) => {
    if ((process.env.RATE_LIMIT ?? "").trim().toLowerCase() === "off") return next();
    const paid = Boolean(c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT"));
    const group = rateGroup(c.req.method, c.req.path, paid);
    const ip = clientIp(c);
    if (!group || LOOPBACK.has(ip)) return next();

    const t = now();
    const key = `${group}:${ip}`;
    let w = windows.get(key);
    if (!w || t - w.start >= WINDOW_MS) {
      if (windows.size > 50_000) for (const [k, v] of windows) if (t - v.start >= WINDOW_MS) windows.delete(k);
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    if (++w.count > limits[group]) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((w.start + WINDOW_MS - t) / 1000))));
      return c.json({ error: "too many requests, try again later" }, 429);
    }
    return next();
  };
}
