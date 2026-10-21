import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config, NETWORK, USDC_ADDRESS } from "./config.js";
import { agent } from "./agents/routes.js";
import { auth } from "./auth/routes.js";
import { buyer } from "./buyer/routes.js";
import { requestSizeLimit } from "./http/bodyLimit.js";
import { corsPolicy, sameSiteWrites } from "./http/cors.js";
import { apiSecurityHeaders, privateNoStore } from "./http/headers.js";
import { rateLimit } from "./http/rateLimit.js";
import { getPayer, markInterruptedRuns } from "./buyer/scout.js";
import { llmAvailable } from "./llm.js";
import { mcp } from "./mcp/server.js";
import { startCredibilityRefresh } from "./registry/credibility.js";
import { verifyBuiltIns } from "./registry/probe.js";
import { startClaimWorker } from "./stake/claims.js";
import { stakeEnabled } from "./stake/index.js";
import { registry } from "./registry/routes.js";
import { activeSellerDefs, buildSellers, seedRegistry } from "./sellers/index.js";
import { startSellerProcesses } from "./sellers/supervisor.js";
import { getResourceServer } from "./x402/resourceServer.js";
import { startResolver } from "./x402/resolver.js";
import { spendCap } from "./x402/spendCap.js";

const app = new Hono();
app.use("*", apiSecurityHeaders());
app.use("*", privateNoStore());
app.use("*", corsPolicy());
app.use("*", sameSiteWrites());
app.use("*", rateLimit());
app.use("*", requestSizeLimit());
app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}: ${err.message}`);
  return c.json({ error: "internal error" }, 500);
});

// SELLER_PROCESSES=on: each seller runs as its own process and this server forwards /sellers/<id>/... to it.
const remote = config.sellerProcesses ? await startSellerProcesses(activeSellerDefs().filter((d) => !d.inProcess).map((d) => d.id)) : new Map<string, number>();
const { app: sellers, active } = buildSellers(remote);
app.route("/auth", auth);
app.route("/agent", agent);
app.route("/registry", registry);
app.route("/sellers", sellers);
app.route("/buyer", buyer);
app.route("/mcp", mcp);

app.get("/api/info", async (c) => {
  let buyerAddress: string | null = null;
  try {
    buyerAddress = getPayer().address;
  } catch {}
  return c.json({
    network: NETWORK,
    asset: USDC_ADDRESS,
    facilitator: config.facilitatorUrl,
    publicBaseUrl: config.publicBaseUrl,
    buyer: buyerAddress,
    sellers: active.map((s) => ({ id: s.id, payTo: s.payTo, endpoint: `${config.publicBaseUrl}/sellers/${s.id}${s.path}`, adversarial: !!s.adversarial })),
    llm: { host: config.ollama.host.replace(/\/\/.*@/, "//"), model: config.ollama.model, available: await llmAvailable() },
    buyerTokenRequired: Boolean(config.buyerToken),
    spendCap: spendCap.status(),
  });
});

app.get("/healthz", (c) => c.json({ ok: true }));

seedRegistry(active);
markInterruptedRuns();
startResolver();
startClaimWorker();
serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Gandiva running on http://localhost:${config.port}  (public: ${config.publicBaseUrl})`);
  console.log(`  web        ${config.publicBaseUrl}/`);
  console.log(`  registry   ${config.publicBaseUrl}/registry/services`);
  console.log(`  mcp        ${config.publicBaseUrl}/mcp  (paid MCP tools over x402)`);
  if (remote.size) console.log(`  sellers    ${remote.size} separate processes on 127.0.0.1:${config.sellerBasePort}-${config.sellerBasePort + remote.size - 1}, own database each (data/sellers/)`);
  for (const s of active) console.log(`  seller     ${config.publicBaseUrl}/sellers/${s.id}${s.path}${s.adversarial ? "  (demo bad actor)" : ""}`);
  try {
    console.log(`  buyer      ${getPayer().address}`);
  } catch (err: any) {
    console.warn(`  buyer      not configured: ${err.message}`);
  }
  verifyBuiltIns()
    .then(() => console.log("  registry   built-in listings probed"))
    .catch((err) => console.error(`  registry   probing built-ins failed: ${err.message}`))
    .finally(() => startCredibilityRefresh());
  if (stakeEnabled()) console.log(`  stake      SellerStakeV2 ${config.stake.contract}${config.stake.verifierKey ? "" : "  (no SERVER_VERIFIER_KEY: claims need both outside verifiers)"}`);
});

getResourceServer()
  .then(() => console.log(`  facilitator ${config.facilitatorUrl} ready`))
  .catch((err) => console.error(`  facilitator init failed: ${err.message}`));
