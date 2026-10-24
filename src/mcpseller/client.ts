import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { decryptSecret, SecretsError } from "../crypto/secrets.js";
import { endpointBlockedReason } from "../registry/probe.js";
import { ServiceError } from "../x402/paidRoute.js";

export const MAX_TOOLS_PER_SERVER = 20;
export const MAX_TEXT_OUT = 50_000;
export const MAX_STRUCTURED_BYTES = 50_000;
const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 40_000;

/** A form problem the seller can fix (status says which kind). */
export class McpSellerError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 429 | 502 | 503 = 400,
  ) {
    super(message);
  }
}

export interface RemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export type ToolAccess = "read" | "write" | "unknown";

/** What the server says about a tool. These are hints from the seller's own server, so "unknown" is common and proves nothing. */
export function toolAccess(tool: Pick<RemoteTool, "annotations">): ToolAccess {
  const hints = tool.annotations;
  if (hints?.readOnlyHint === true) return "read";
  return hints?.readOnlyHint === false || hints?.destructiveHint === true ? "write" : "unknown";
}

/** An MCP server must be a public https URL, checked again on every call (DNS can change). Returns the cleaned URL. */
export async function checkMcpUrl(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpSellerError("MCP URL must be a web address like https://huggingface.co/mcp");
  }
  if (url.protocol !== "https:") throw new McpSellerError("MCP URL must use https");
  const blocked = await endpointBlockedReason(url.href, false);
  if (blocked) throw new McpSellerError(`MCP URL not allowed: ${blocked.replace("endpoint", "URL")}`);
  return url.href;
}

const redact = (text: string, secret: string) => (secret ? text.split(secret).join("***") : text);

export function readToken(tokenEnc: string | null): string {
  if (!tokenEnc) return "";
  try {
    return decryptSecret(tokenEnc);
  } catch (err) {
    throw new SecretsError(err instanceof SecretsError ? "the saved token cannot be read; the seller must save it again" : "the saved token cannot be read");
  }
}

const newClient = () => new Client({ name: "gandiva-mcp-seller", version: "0.1.0" });
const noRedirects: typeof fetch = (url, init) => fetch(url, { ...init, redirect: "error" });
/** What an older SSE-only server answers to a Streamable HTTP request, per the MCP spec's backwards-compatibility rule. */
const SSE_ONLY_ANSWERS = new Set([400, 404, 405]);

/**
 * One short-lived session: connect (the SDK handles mcp-session-id), run `fn`, always close. No redirects are followed.
 * Older SSE-only servers get a second try at connecting. Only connecting is retried, so a paid tool call never runs twice.
 */
async function withClient<T>(url: string, token: string, timeoutMs: number, fn: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
  const requestInit: RequestInit = { redirect: "error", headers: token ? { Authorization: `Bearer ${token}` } : {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // An SSE server can hold the connection open and never send its first event, so the deadline has to cover connecting too.
  const timedOut = new Promise<never>((_, reject) => ctrl.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true }));
  const connect = (c: Client, transport: Transport) => Promise.race([c.connect(transport, { signal: ctrl.signal, timeout: timeoutMs }), timedOut]);
  let client = newClient();
  try {
    try {
      await connect(client, new StreamableHTTPClientTransport(new URL(url), { requestInit }));
    } catch (err) {
      if (!(err instanceof StreamableHTTPError && SSE_ONLY_ANSWERS.has(err.code ?? 0))) throw err;
      await client.close().catch(() => {});
      client = newClient();
      await connect(client, new SSEClientTransport(new URL(url), { requestInit, eventSourceInit: { fetch: noRedirects } }));
    }
    return await fn(client, ctrl.signal);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

const OAUTH_NOTE = "Servers that only allow a browser sign-in (OAuth) are not supported yet.";

const fail = (err: unknown, token: string, ctrlTimeout: string): string => {
  if ((err as any)?.code === 401) return token ? `the server refused this token. ${OAUTH_NOTE}` : `the server needs a sign-in, so give a bearer token. ${OAUTH_NOTE}`;
  return redact(String((err as any)?.message ?? err), token).split("\n")[0].slice(0, 200) || ctrlTimeout;
};

/** Every tool the server offers (first pages only, capped). */
export async function listRemoteTools(url: string, token: string): Promise<RemoteTool[]> {
  try {
    return await withClient(url, token, LIST_TIMEOUT_MS, async (client, signal) => {
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 3; page++) {
        const res = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: LIST_TIMEOUT_MS });
        for (const t of res.tools) tools.push({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, annotations: t.annotations });
        cursor = res.nextCursor;
        if (!cursor || tools.length > MAX_TOOLS_PER_SERVER * 5) break;
      }
      return tools;
    });
  } catch (err) {
    throw new McpSellerError(`could not read the tools of that MCP server: ${fail(err, token, "timed out")}`, 502);
  }
}

/** What a paid call returns: the tool's text, plus its structured result when it has one. */
export interface ToolAnswer {
  text: string;
  structuredContent?: Record<string, unknown>;
}

/** One tool call. Throws ServiceError for anything that is not a good answer, so the buyer is never charged for it. */
export async function callRemoteTool(url: string, token: string, tool: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  let result: Awaited<ReturnType<Client["callTool"]>>;
  try {
    result = await withClient(url, token, CALL_TIMEOUT_MS, (client, signal) => client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS }));
  } catch (err) {
    throw new ServiceError(`MCP server unavailable: ${fail(err, token, "timed out")}`, 502);
  }
  const content = Array.isArray((result as any).content) ? ((result as any).content as { type: string; text?: string }[]) : [];
  const text = content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
  if ((result as any).isError) throw new ServiceError(`the tool reported an error: ${redact(text, token).slice(0, 200) || "no details"}`, 502);
  const structured = (result as any).structuredContent as Record<string, unknown> | undefined;
  if (!text.trim() && !structured) throw new ServiceError("the tool returned nothing", 502);
  if (text.length > MAX_TEXT_OUT) throw new ServiceError(`the tool answer is too large (${text.length} characters, max ${MAX_TEXT_OUT})`, 502);
  if (structured && JSON.stringify(structured).length > MAX_STRUCTURED_BYTES) throw new ServiceError("the tool's structured answer is too large", 502);
  return { text: text || JSON.stringify(structured), ...(structured ? { structuredContent: structured } : {}) };
}
