import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { isSignedInPath } from "./cors.js";

/**
 * Browser hardening on every API response: no MIME sniffing, no framing, no referrer, HSTS. The marketplace is a
 * public API that other sites and agents call, so Cross-Origin-Resource-Policy stays off.
 */
export const apiSecurityHeaders = () => secureHeaders({ xFrameOptions: "DENY", crossOriginResourcePolicy: false });

/** Answers on signed-in routes (wallet, runs, the Sell tab) are about one user: never kept by a browser or proxy cache. */
export const privateNoStore = (): MiddlewareHandler => async (c, next) => {
  await next();
  if (isSignedInPath(c.req.path)) c.header("Cache-Control", "no-store");
};
