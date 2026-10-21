import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { SESSION_COOKIE } from "../auth/routes.js";
import { config } from "../config.js";

// Routes that act for the signed-in user (sign-in, agent wallet, runs, the Sell tab). Everything else is the public
// x402 marketplace that any site or agent may call.
const SIGNED_IN = /^\/(auth|agent|buyer)(\/|$)|^\/registry\/mine(\/|$)/;
export const isSignedInPath = (path: string) => SIGNED_IN.test(path);

const open = cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] });
// The UI calls through its own proxy (same origin), so other sites never need these.
const siteOnly = cors({ origin: (origin) => (config.siteOrigins.includes(origin) ? origin : null) });

export const corsPolicy = (): MiddlewareHandler => (c, next) => (isSignedInPath(c.req.path) ? siteOnly(c, next) : open(c, next));

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A write that carries the session cookie must come from the UI's own pages: a different (or "null") Origin, or a
 * browser that marks it cross-site, is refused. The SameSite=Lax cookie already stops most of these; this is the second lock.
 * Requests without an Origin are not from a browser page, so there is nothing to forge.
 */
export const sameSiteWrites = (): MiddlewareHandler => async (c, next) => {
  if (READ_METHODS.has(c.req.method) || !getCookie(c, SESSION_COOKIE)) return next();
  const origin = c.req.header("origin");
  if ((origin !== undefined && !config.siteOrigins.includes(origin)) || c.req.header("sec-fetch-site") === "cross-site") {
    return c.json({ error: "signed-in changes are only accepted from this site's own pages" }, 403);
  }
  return next();
};
