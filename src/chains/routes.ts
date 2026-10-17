import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { currentUser } from "../auth/routes.js";
import { config } from "../config.js";
import { RegistryError, getService } from "../registry/store.js";
import { verifyService } from "../registry/probe.js";
import { ChainError, quoteChain, saveChain, testChain } from "./chains.js";

/** Sell-tab "agent chain" template, mounted at /registry/mine/chains. */
export const chainRoutes = new Hono();

const MAX_BODY = 32 * 1024;
const tooLarge = (c: any) => c.json({ error: `request too large (max ${MAX_BODY} bytes)` }, 413);

function failure(c: any, err: unknown) {
  if (err instanceof ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`).join("; "), issues: err.issues }, 400);
  if (err instanceof ChainError || err instanceof RegistryError) return c.json({ error: err.message }, err.status);
  return c.json({ error: "body must be valid JSON" }, 400);
}

chainRoutes.post("/", bodyLimit({ maxSize: MAX_BODY, onError: tooLarge }), async (c) => {
  const me = currentUser(c);
  if (!me) return c.json({ error: "sign in with your wallet first" }, 401);
  try {
    const service = await saveChain(await c.req.json(), me);
    // Probe over loopback: the listed URL may be a tunnel that this machine cannot always reach.
    await verifyService(service, { endpoint: service.endpoint.replace(config.publicBaseUrl, `http://127.0.0.1:${config.port}`), timeoutMs: 20_000 });
    return c.json(getService(service.id), 201);
  } catch (err) {
    return failure(c, err);
  }
});

chainRoutes.post("/quote", bodyLimit({ maxSize: MAX_BODY, onError: tooLarge }), async (c) => {
  const me = currentUser(c);
  if (!me) return c.json({ error: "sign in with your wallet first" }, 401);
  try {
    return c.json(await quoteChain(await c.req.json(), me));
  } catch (err) {
    return failure(c, err);
  }
});

// Spends real (testnet) USDC from the owner's agent wallet: the hired sellers are paid for real.
chainRoutes.post("/test", bodyLimit({ maxSize: MAX_BODY, onError: tooLarge }), async (c) => {
  const me = currentUser(c);
  if (!me) return c.json({ error: "sign in with your wallet first" }, 401);
  try {
    return c.json(await testChain(await c.req.json(), me));
  } catch (err) {
    return failure(c, err);
  }
});
