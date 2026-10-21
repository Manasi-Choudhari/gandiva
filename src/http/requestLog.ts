import type { ErrorHandler, MiddlewareHandler } from "hono";
import { requestId } from "hono/request-id";
import { log } from "../log.js";
import { clientIp } from "./clientIp.js";

/** Tags each request with an id, sent back as X-Request-Id. A client's own id is kept only if it is short and plain. */
export const requestIds = () => requestId({ limitLength: 64 });

/** One line per request. Only the path, never the query string, headers or body: those carry payment signatures and sign-in data. */
export function requestLog(): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    if (c.req.path === "/healthz" && c.res.ok) return; // polled all day; only a failure is worth a line
    log(c.res.status >= 500 ? "error" : "info", "request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
      ip: clientIp(c),
      requestId: c.get("requestId"),
    });
  };
}

/** The caller gets only the request id, which finds the real error in the logs. */
export const onServerError: ErrorHandler = (err, c) => {
  const id = c.get("requestId");
  log("error", "unhandled error", { method: c.req.method, path: c.req.path, requestId: id, error: err.message });
  return c.json({ error: "internal error", requestId: id }, 500);
};
