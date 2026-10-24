import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { currentUser } from "../auth/routes.js";
import { config } from "../config.js";
import { RegistryError, getService } from "../registry/store.js";
import { verifyService } from "../registry/probe.js";
import { McpSellerError } from "./client.js";
import { loadTools, saveServer, testTool } from "./servers.js";

/** Sell-tab "MCP server" template, mounted at /registry/mine/mcp-servers. */
export const mcpSellerRoutes = new Hono();

const MAX_BODY = 8 * 1024;
const MAX_TEST_BODY = 32 * 1024;
const tooLarge = (c: any) => c.json({ error: `request too large (max ${MAX_BODY} bytes)` }, 413);
const testTooLarge = (c: any) => c.json({ error: `request too large (max ${MAX_TEST_BODY} bytes)` }, 413);

function failure(c: any, err: unknown) {
  if (err instanceof ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`).join("; "), issues: err.issues }, 400);
  if (err instanceof McpSellerError || err instanceof RegistryError) return c.json({ error: err.message }, err.status);
  if (err instanceof SyntaxError) return c.json({ error: "body must be valid JSON" }, 400);
  throw err; // anything else is a real failure: app.onError logs it and answers 500
}

mcpSellerRoutes.post("/", bodyLimit({ maxSize: MAX_BODY, onError: tooLarge }), async (c) => {
  const me = currentUser(c);
  if (!me) return c.json({ error: "sign in with your wallet first" }, 401);
  try {
    const saved = await saveServer(await c.req.json(), me);
    // Probe each listing over loopback: the listed URL may be a tunnel that this machine cannot always reach.
    await Promise.all(saved.listed.map((s) => verifyService(s, { endpoint: s.endpoint.replace(config.publicBaseUrl, `http://127.0.0.1:${config.port}`), timeoutMs: 20_000 })));
    return c.json({ ...saved, listed: saved.listed.map((s) => getService(s.id)) }, 201);
  } catch (err) {
    return failure(c, err);
  }
});

mcpSellerRoutes.post("/tools", bodyLimit({ maxSize: MAX_BODY, onError: tooLarge }), async (c) => {
  const me = currentUser(c);
  if (!me) return c.json({ error: "sign in with your wallet first" }, 401);
  try {
    return c.json(await loadTools(await c.req.json(), me));
  } catch (err) {
    return failure(c, err);
  }
});

mcpSellerRoutes.post("/test", bodyLimit({ maxSize: MAX_TEST_BODY, onError: testTooLarge }), async (c) => {
  const me = currentUser(c);
  if (!me) return c.json({ error: "sign in with your wallet first" }, 401);
  try {
    return c.json(await testTool(await c.req.json(), me));
  } catch (err) {
    return failure(c, err);
  }
});
