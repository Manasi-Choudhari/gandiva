import type { Context } from "hono";
import { z } from "zod";
import { sampleFromSchema } from "../buyer/catalogue.js";
import { config, MAX_PRICE_UNITS } from "../config.js";
import { encryptSecret, secretsConfigured } from "../crypto/secrets.js";
import { db } from "../db.js";
import { CATEGORIES, deleteService, getService, listByOwner, MAX_LISTINGS_PER_WALLET, RegistryError, registerForWallet, slug, walletOwner, type Service } from "../registry/store.js";
import { paidRoute, ServiceError } from "../x402/paidRoute.js";
import { hasRiskyPattern, validateInput } from "../x402/schema.js";
import { callRemoteTool, checkMcpUrl, listRemoteTools, MAX_TEXT_OUT, MAX_TOOLS_PER_SERVER, McpSellerError, readToken, toolAccess, type RemoteTool, type ToolAccess, type ToolAnswer } from "./client.js";

const MAX_SCHEMA_BYTES = 8000;
const MAX_SCHEMA_DESCRIPTION = 500;
const MAX_LISTING_DESCRIPTION = 400;

export interface McpToolRow {
  serviceId: string;
  /** Wallet that owns the listing (lower case). */
  owner: string;
  serverId: string;
  url: string;
  /** Encrypted bearer token, or null when the server needs none. */
  tokenEnc: string | null;
  toolName: string;
}

const rowToTool = (r: any): McpToolRow => ({ serviceId: r.service_id, owner: r.owner, serverId: r.server_id, url: r.url, tokenEnc: r.token_enc, toolName: r.tool_name });

export const getMcpTool = (serviceId: string): McpToolRow | undefined => {
  const r = db.prepare("SELECT * FROM mcp_sellers WHERE service_id = ?").get(serviceId);
  return r ? rowToTool(r) : undefined;
};
export const isMcpService = (serviceId: string): boolean => Boolean(db.prepare("SELECT 1 FROM mcp_sellers WHERE service_id = ?").get(serviceId));

const rowsFor = (wallet: string, serverId: string): McpToolRow[] => db.prepare("SELECT * FROM mcp_sellers WHERE owner = ? AND server_id = ?").all(wallet.toLowerCase(), serverId).map(rowToTool);
const rowsForUrl = (wallet: string, url: string): McpToolRow[] => db.prepare("SELECT * FROM mcp_sellers WHERE owner = ? AND url = ?").all(wallet.toLowerCase(), url).map(rowToTool);

/** What the Sell tab may show about a wallet's MCP listings. Never the token. */
export function listMcpFor(wallet: string): Record<string, { serverId: string; url: string; tool: string; hasToken: boolean }> {
  const rows = db.prepare("SELECT * FROM mcp_sellers WHERE owner = ?").all(wallet.toLowerCase()).map(rowToTool);
  return Object.fromEntries(rows.map((r) => [r.serviceId, { serverId: r.serverId, url: r.url, tool: r.toolName, hasToken: Boolean(r.tokenEnc) }]));
}

/** The token this wallet already saved for exactly this URL. A token is never carried over to a different URL. */
const savedTokenFor = (wallet: string, url: string): string | null => {
  const r = db.prepare("SELECT token_enc FROM mcp_sellers WHERE owner = ? AND url = ? AND token_enc IS NOT NULL LIMIT 1").get(wallet.toLowerCase(), url) as { token_enc: string } | undefined;
  return r?.token_enc ?? null;
};

/** Every MCP tool answers in this shape. */
export const mcpOutputSchema = {
  type: "object",
  required: ["text"],
  properties: { text: { type: "string", minLength: 1, maxLength: MAX_TEXT_OUT }, structuredContent: { type: "object" } },
};

const form = {
  url: z.string().trim().min(1, "enter the MCP server URL").max(500),
  token: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((k) => k || undefined),
};
const toolName = z.string().min(1).max(200);
const loadForm = z.object({ ...form, serverId: z.string().max(40).optional() });
const testForm = z.object({ ...form, tool: toolName, input: z.record(z.string(), z.unknown()).default({}) });
const saveForm = z.object({
  ...form,
  name: z.string().trim().min(1).max(40).optional(),
  category: z.enum(CATEGORIES),
  /** The tools to sell. Any other tool of this server is taken off the marketplace. */
  tools: z
    .array(
      z.object({
        name: toolName,
        price: z
          .string()
          .regex(/^\d+$/, "price is in USDC smallest units")
          .refine((p) => BigInt(p) > 0n && BigInt(p) <= MAX_PRICE_UNITS, "price must be > 0 and <= 100000 (0.10 USDC)"),
      }),
    )
    .min(1, "pick at least one tool")
    .max(MAX_TOOLS_PER_SERVER, `pick at most ${MAX_TOOLS_PER_SERVER} tools`)
    .refine((tools) => new Set(tools.map((t) => t.name)).size === tools.length, "a tool was picked twice"),
  /** Set by Refresh, which is the one place a group may move to a new URL. */
  changeUrl: z.boolean().optional(),
});

/** "https://mcp.example.co.uk/x" -> "example": the name a listing group gets when the seller gives none. */
export function defaultServerName(url: string): string {
  const labels = new URL(url).hostname.split(".").filter((l) => l && !["www", "mcp", "api"].includes(l));
  const name = slug(labels.length > 1 ? labels[labels.length - 2] : (labels[0] ?? "mcp"));
  return name.length >= 2 ? name : "mcp";
}

/** The schema as the registry stores it: cut descriptions, no `$schema`, always an object, and it must compile. Null = not sellable. */
function cleanSchema(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return { type: "object", properties: {} };
  const walk = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(walk)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "description" && typeof x === "string" ? x.slice(0, MAX_SCHEMA_DESCRIPTION) : walk(x)]))
        : v;
  const schema = walk(raw) as Record<string, unknown>;
  delete schema.$schema;
  delete schema.$id;
  schema.type = "object";
  if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES || hasRiskyPattern(schema)) return null;
  try {
    validateInput(schema, {});
  } catch {
    return null;
  }
  return schema;
}

export interface SavedServer {
  serverId: string;
  name: string;
  url: string;
  listed: Service[];
  skipped: { tool: string; reason: string }[];
  removed: string[];
  hasToken: boolean;
}

const TRIAL_LIMIT = 20;
const TRIAL_WINDOW_MS = 3_600_000;
const trialLog = new Map<string, number[]>();
const testLog = new Map<string, number[]>();
/** For tests: forget every wallet's recent server checks and test calls. */
export const resetServerChecks = () => {
  trialLog.clear();
  testLog.clear();
};
function countIn(log: Map<string, number[]>, what: string, wallet: string, now: number) {
  const recent = (log.get(wallet) ?? []).filter((t) => now - t < TRIAL_WINDOW_MS);
  if (recent.length >= TRIAL_LIMIT) throw new McpSellerError(`at most ${TRIAL_LIMIT} ${what} per hour`, 429);
  log.set(wallet, [...recent, now]);
}
/** Reaching a remote server is rate-limited per wallet: "Load tools" and every save count. */
const countTrial = (wallet: string, now: number) => countIn(trialLog, "server checks", wallet, now);

const needSecrets = (token: string | undefined) => {
  if (token && !secretsConfigured()) throw new McpSellerError("this server has no SECRETS_KEY, so it cannot store tokens yet", 503);
};

export interface LoadedTool {
  name: string;
  description: string;
  usable: boolean;
  access: ToolAccess;
  /** The current price in USDC smallest units when this tool is already on sale. */
  listedPrice: string | null;
  /** Placeholder input for the free test call, built from the tool's input schema. */
  sample: unknown;
}

/** Required fields only: a made-up value in an optional filter makes a good tool look broken by hiding its results. */
function sampleInput(schema: Record<string, unknown>): Record<string, unknown> {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.fromEntries(Object.entries(sampleFromSchema(schema) as Record<string, unknown>).filter(([field]) => required.has(field)));
}

/** Free, owner-only look at a server's tools (nothing is listed or paid). `serverId` is the group being refreshed, if any. */
export async function loadTools(raw: unknown, wallet: string, now = Date.now()): Promise<{ url: string; name: string; hasToken: boolean; tools: LoadedTool[] }> {
  const f = loadForm.parse(raw);
  needSecrets(f.token);
  countTrial(wallet, now);
  const url = await checkMcpUrl(f.url);
  const savedEnc = f.token ? null : savedTokenFor(wallet, url);
  const tools = await listRemoteTools(url, f.token ?? readToken(savedEnc));
  const rows = f.serverId ? rowsFor(wallet, f.serverId) : rowsForUrl(wallet, url);
  const listedPrice = new Map(rows.map((r) => [r.toolName, getService(r.serviceId)?.price ?? null]));
  return {
    url,
    name: defaultServerName(url),
    hasToken: Boolean(f.token ?? savedEnc),
    tools: tools.map((t) => {
      const schema = cleanSchema(t.inputSchema);
      return {
        name: t.name,
        description: (t.description ?? t.title ?? "").slice(0, 200),
        usable: schema !== null,
        access: toolAccess(t),
        listedPrice: listedPrice.get(t.name) ?? null,
        sample: schema ? sampleInput(schema) : {},
      };
    }),
  };
}

/**
 * Free, owner-only run of one tool with the URL and token in the form (nothing is listed or paid, no sale is recorded).
 * It really runs on the seller's server, so a tool that changes data changes it. Input gets the same check as a paid call.
 */
export async function testTool(raw: unknown, wallet: string, now = Date.now()): Promise<ToolAnswer & { ms: number }> {
  const f = testForm.parse(raw);
  needSecrets(f.token);
  countIn(testLog, "test calls", wallet, now);
  const url = await checkMcpUrl(f.url);
  const token = f.token ?? readToken(savedTokenFor(wallet, url));
  const tool = (await listRemoteTools(url, token)).find((t) => t.name === f.tool);
  if (!tool) throw new McpSellerError(`that server has no tool called "${f.tool}"`);
  const schema = cleanSchema(tool.inputSchema);
  if (!schema) throw new McpSellerError("this tool cannot be sold: its input description is too large or not supported");
  const input = validateInput(schema, f.input);
  if (!input.ok) throw new McpSellerError(`invalid input: ${input.error}`);
  const started = Date.now();
  try {
    return { ...(await callRemoteTool(url, token, f.tool, f.input)), ms: Date.now() - started };
  } catch (err) {
    if (err instanceof ServiceError) throw new McpSellerError(err.message, 502);
    throw err;
  }
}

/**
 * Lists the tools the seller picked, each as its own paid listing at its own price (paid to the signed-in wallet).
 * Saving the same group again applies the new picks: tools left out, or dropped by the server, leave the marketplace.
 */
export async function saveServer(raw: unknown, wallet: string, now = Date.now()): Promise<SavedServer> {
  const f = saveForm.parse(raw);
  needSecrets(f.token);
  countTrial(wallet, now);
  const url = await checkMcpUrl(f.url);
  const owner = walletOwner(wallet);
  const name = f.name ?? defaultServerName(url);
  const serverId = slug(name).slice(0, 30);
  if (serverId.length < 2) throw new McpSellerError("server name must contain letters or numbers");

  // Without this, a second server that happens to get the same group name would replace the first one's listings.
  const previous = rowsFor(wallet, serverId);
  const elsewhere = previous.find((r) => r.url !== url);
  if (elsewhere && !f.changeUrl) throw new McpSellerError(`"${serverId}" is already your group for ${elsewhere.url}. Choose another group name, or use Refresh server to move it.`, 409);

  const tokenEnc = f.token ? encryptSecret(f.token) : savedTokenFor(wallet, url);
  const remote = await listRemoteTools(url, f.token ?? readToken(tokenEnc));
  if (!remote.length) throw new McpSellerError("that MCP server has no tools to sell");

  const prices = new Map(f.tools.map((t) => [t.name, t.price]));
  const offered = new Set(remote.map((t) => t.name));
  const skipped: SavedServer["skipped"] = f.tools.filter((t) => !offered.has(t.name)).map((t) => ({ tool: t.name, reason: "the server no longer offers it" }));
  const removed = previous.filter((r) => !prices.has(r.toolName) || !offered.has(r.toolName)).map((r) => r.serviceId);
  const keptIds = new Set(previous.map((r) => r.serviceId).filter((id) => !removed.includes(id)));
  const candidates: { id: string; tool: RemoteTool; schema: Record<string, unknown>; price: string }[] = [];
  const seen = new Set<string>();
  for (const tool of remote) {
    const price = prices.get(tool.name);
    if (!price) continue;
    const id = slug(`${serverId}-${tool.name}`);
    if (seen.has(id)) {
      skipped.push({ tool: tool.name, reason: "its name clashes with another tool of this server" });
      continue;
    }
    seen.add(id);
    const schema = cleanSchema(tool.inputSchema);
    if (!schema) skipped.push({ tool: tool.name, reason: "its input description is too large or not supported" });
    else candidates.push({ id, tool, schema, price });
  }

  // Tools that are already listed come first, so a refresh never drops a working listing in favour of a new one.
  candidates.sort((a, b) => Number(keptIds.has(b.id)) - Number(keptIds.has(a.id)));

  // One transaction: tools leave first so they free their slots, and a save that lists nothing changes nothing.
  const listed = db.transaction(() => {
    for (const id of removed) deleteService(id);
    const room = Math.min(MAX_TOOLS_PER_SERVER, MAX_LISTINGS_PER_WALLET - listByOwner(wallet).length + keptIds.size);
    const done: Service[] = [];
    for (const { id, tool, schema, price } of candidates) {
      if (done.length >= room) {
        skipped.push({ tool: tool.name, reason: `listing limit reached (${MAX_LISTINGS_PER_WALLET} per wallet)` });
        continue;
      }
      const existing = getService(id);
      if (existing && existing.owner === owner && !keptIds.has(id)) {
        skipped.push({ tool: tool.name, reason: `"${id}" is already one of your other listings` });
        continue;
      }
      try {
        const host = new URL(url).hostname;
        const about = (tool.description ?? tool.title ?? tool.name).replace(/\s+/g, " ").trim();
        // Its own savepoint, so a listing never exists without the row that says which tool it calls.
        const service = db.transaction(() => {
          const s = registerForWallet(
            {
              id,
              name: `${name}: ${tool.title ?? tool.name}`.slice(0, 80),
              category: f.category,
              endpoint: `${config.publicBaseUrl}/sellers/u/${id}/call`,
              method: "POST",
              price,
              description: `${about.slice(0, MAX_LISTING_DESCRIPTION)} (MCP tool from ${host})`.slice(0, 500),
              inputSchema: schema,
              outputSchema: mcpOutputSchema,
            },
            wallet,
          );
          db.prepare(
            `INSERT INTO mcp_sellers (service_id, owner, server_id, url, token_enc, tool_name) VALUES (?,?,?,?,?,?)
             ON CONFLICT(service_id) DO UPDATE SET server_id=excluded.server_id, url=excluded.url, token_enc=excluded.token_enc, tool_name=excluded.tool_name`,
          ).run(s.id, wallet.toLowerCase(), serverId, url, tokenEnc, tool.name);
          return s;
        })();
        done.push(service);
      } catch (err) {
        if (!(err instanceof RegistryError)) throw err;
        skipped.push({ tool: tool.name, reason: err.message });
      }
    }
    if (!done.length) throw new McpSellerError(`none of the tools could be listed: ${skipped.map((s) => `${s.tool} (${s.reason})`).join("; ").slice(0, 300)}`);
    db.prepare("UPDATE mcp_sellers SET url = ?, token_enc = ? WHERE owner = ? AND server_id = ?").run(url, tokenEnc, wallet.toLowerCase(), serverId);
    return done;
  })();
  return { serverId, name, url, listed, skipped, removed, hasToken: Boolean(tokenEnc) };
}

/** Takes every tool of one of this wallet's servers off the marketplace, along with its stored URL and token. */
export const deleteServer = db.transaction((wallet: string, serverId: string): string[] => {
  const ids = rowsFor(wallet, serverId).map((r) => r.serviceId);
  for (const id of ids) deleteService(id);
  return ids;
});

/** One paid call to the seller's tool, with the seller's stored URL and token. Throws ServiceError so a failed call is never charged. */
export async function runMcpTool(row: McpToolRow, input: Record<string, unknown>): Promise<ToolAnswer> {
  let url: string;
  try {
    url = await checkMcpUrl(row.url);
  } catch (err: any) {
    throw new ServiceError(`seller's MCP server is not allowed: ${err.message}`, 502);
  }
  let token: string;
  try {
    token = readToken(row.tokenEnc);
  } catch (err: any) {
    throw new ServiceError(`seller's ${err.message}`, 502);
  }
  return callRemoteTool(url, token, row.toolName, input);
}

/** POST /sellers/u/:id/call: the paid x402 route of one MCP-tool listing, built from its stored settings on every request. */
export async function mcpToolRoute(c: Context) {
  const id = c.req.param("id") ?? "";
  const service = getService(id);
  const row = getMcpTool(id);
  if (!service || !row || service.owner !== walletOwner(row.owner)) return c.json({ error: "no such tool" }, 404);
  const route = paidRoute<Record<string, unknown>, ToolAnswer>({
    seller: id,
    description: service.description,
    price: BigInt(service.price),
    payTo: service.payTo,
    inputSchema: service.inputSchema,
    outputSchema: service.outputSchema,
    handler: (input) => runMcpTool(row, input),
  });
  return route(c);
}
