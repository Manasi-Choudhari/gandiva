import type { Context } from "hono";
import { db } from "../db.js";
import { log } from "../log.js";
import { spendCap } from "../x402/spendCap.js";

/** Render and the Docker HEALTHCHECK poll this, so it stays one cheap query. A database that can't answer means a restart is due. */
export function healthz(c: Context) {
  try {
    db.prepare("SELECT 1").get();
    return c.json({ ok: true });
  } catch (err: any) {
    log("error", "healthz: database check failed", { error: String(err?.message ?? err) });
    return c.json({ ok: false }, 503);
  }
}

/** The shared wallet's spend cap, or null when it can't be read: a malformed BUYER_PRIVATE_KEY must not take /api/info down with it. */
export function spendCapStatus() {
  try {
    return spendCap.status();
  } catch {
    return null;
  }
}
