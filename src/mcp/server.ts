import { Hono } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPaymentWrapper, createToolResourceUrl, MCP_PAYMENT_RESPONSE_META_KEY, type ToolResult } from "@x402/mcp";
import type { x402ResourceServer } from "@x402/core/server";
import { config, fromUnits, NETWORK, USDC_ADDRESS, USDC_EIP712 } from "../config.js";
import { askModel, getHosted } from "../hosted/agents.js";
import { getMcpTool, runMcpTool } from "../mcpseller/servers.js";
import { addSale, getService, listServices, reputationFor, searchServices, walletOwner, type ToolAccess } from "../registry/store.js";
import { activeSellerDefs } from "../sellers/index.js";
import { nonceKey, replayGuard, ServiceError } from "../x402/paidRoute.js";
import { getResourceServer } from "../x402/resourceServer.js";
import { validate, validateInput } from "../x402/schema.js";

/**
 * Paid MCP tools (x402 over MCP, @x402/mcp): the same sellers as the HTTP marketplace, at the same price, paid to the same
 * payTo, with the same "no service, no charge" order (verify -> run -> check output -> settle) and the same replay guard.
 * Tools: every honest built-in seller, and every Sell-tab LLM agent (both run on this server, so we can charge for them).
 * Sell-tab "own endpoint" listings are not wrapped: their own server asks for its own payment.
 */

interface PaidTool {
  name: string;
  serviceId: string;
  description: string;
  price: bigint;
  payTo: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /** Honest sellers check their own output before settling. */
  selfValidate: boolean;
  /** MCP-seller tools only: passed on so an MCP client can warn before calling a tool that changes data. */
  access?: ToolAccess;
  run: (input: any) => Promise<unknown>;
}

const TOOL_TIMEOUT_MS = 60_000;
const toolName = (serviceId: string) => serviceId.replace(/-/g, "_");

/** The paid tools right now (Sell-tab agents come and go, so this is rebuilt on every request). */
export function paidTools(): PaidTool[] {
  const builtIn: PaidTool[] = activeSellerDefs()
    .filter((d) => !d.adversarial)
    .map((d) => ({
      name: toolName(d.id),
      serviceId: d.id,
      description: d.description,
      price: d.listedPrice,
      payTo: d.payTo,
      inputSchema: d.inputSchema,
      outputSchema: d.outputSchema,
      selfValidate: d.selfValidate ?? true,
      run: d.handler,
    }));
  const agents: PaidTool[] = listServices()
    .filter((s) => s.owner.startsWith("wallet:") && s.endpoint.startsWith(`${config.publicBaseUrl}/sellers/u/`))
    .flatMap((s) => {
      const agent = getHosted(s.id);
      if (!agent || s.owner !== walletOwner(agent.owner)) return [];
      return [
        {
          name: toolName(s.id),
          serviceId: s.id,
          description: `${s.description} (Sell-tab LLM agent, paid to ${s.payTo})`,
          price: BigInt(s.price),
          payTo: s.payTo,
          inputSchema: s.inputSchema,
          outputSchema: s.outputSchema,
          selfValidate: true,
          run: (input: { text: string }) => askModel(agent, input.text),
        },
      ];
    });
  const mcpTools: PaidTool[] = listServices().flatMap((s) => {
    const row = s.owner.startsWith("wallet:") ? getMcpTool(s.id) : undefined;
    if (!row || s.owner !== walletOwner(row.owner)) return [];
    return [
      {
        name: toolName(s.id),
        serviceId: s.id,
        description: `${s.access === "write" ? "CHANGES DATA on the seller's server. " : ""}${s.description} (Sell-tab MCP tool, paid to ${s.payTo})`,
        price: BigInt(s.price),
        payTo: s.payTo,
        inputSchema: s.inputSchema,
        outputSchema: s.outputSchema,
        selfValidate: true,
        access: s.access,
        run: (input: Record<string, unknown>) => runMcpTool(row, input),
      },
    ];
  });
  return [...builtIn, ...agents, ...mcpTools];
}

const FREE_TOOLS = [
  {
    name: "list_services",
    description: "Free. Lists the marketplace's services (best-ranked first) with price, payTo, reputation and whether their 402 was verified.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["data", "inference", "scraping"] },
        maxPrice: { type: "string", pattern: "^\\d+$", description: "USDC smallest units" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_reputation",
    description: "Free. Reputation of one service: success rate, median latency, time-weighted score.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
];

const text = (value: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError } : {}) });

function freeTool(name: string, args: Record<string, unknown>): ToolResult {
  if (name === "list_services") {
    const services = searchServices({ category: args.category as string | undefined, maxPrice: args.maxPrice as string | undefined }).map((s) => ({
      id: s.id,
      mcpTool: paidTools().some((t) => t.serviceId === s.id) ? toolName(s.id) : null,
      name: s.name,
      category: s.category,
      price_usdc: fromUnits(s.price),
      payTo: s.payTo,
      ...(s.access ? { access: s.access } : {}),
      verification: s.verification,
      reputation: { score: Number(s.reputation.score.toFixed(3)), successRate: s.reputation.successRate, attempts: s.reputation.attempts, isNew: s.reputation.isNew },
      description: s.description,
    }));
    return text({ services });
  }
  const id = String(args.id ?? "");
  if (!getService(id)) return text(`no service "${id}"`, true);
  return text({ id, reputation: reputationFor(id) });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ServiceError(`tool timed out after ${ms} ms`, 504)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** One paid tool call: x402 payment via @x402/mcp, our replay guard and sales records around it. */
async function callPaidTool(server: x402ResourceServer, tool: PaidTool, args: Record<string, unknown>, extra: unknown) {
  const started = Date.now();
  const accepts = await server.buildPaymentRequirements({
    scheme: "exact",
    network: NETWORK,
    payTo: tool.payTo,
    price: { amount: tool.price.toString(), asset: USDC_ADDRESS, extra: { ...USDC_EIP712, assetTransferMethod: "eip3009" } },
    maxTimeoutSeconds: 120,
  });
  let claimed: string | null = null;
  let payer: string | undefined;
  const paid = createPaymentWrapper(server, {
    accepts,
    resource: { url: createToolResourceUrl(tool.name), description: tool.description, mimeType: "application/json", serviceName: "Gandiva" },
    hooks: {
      // One authorisation, one response: the same nonce table the HTTP sellers use.
      onBeforeExecution: ({ paymentPayload }) => {
        const key = nonceKey(paymentPayload);
        payer = (paymentPayload.payload as any)?.authorization?.from;
        if (!replayGuard.claim(key, `mcp:${tool.serviceId}`)) {
          addSale({ seller: tool.serviceId, payer, amount: "0", status: "replay_rejected", reason: "MCP: authorization already used", latencyMs: Date.now() - started });
          return false;
        }
        claimed = key;
      },
      onAfterSettlement: ({ settlement }) => {
        if (claimed) replayGuard.settled(claimed, settlement.transaction);
        addSale({ seller: tool.serviceId, payer: settlement.payer ?? payer, amount: tool.price.toString(), txHash: settlement.transaction, status: "paid", reason: "via MCP", latencyMs: Date.now() - started });
      },
    },
  });
  // Errors come back as isError results, so the wrapper never settles them: no service, no charge.
  const result = await paid(async (input: Record<string, unknown>) => {
    try {
      const output = await withTimeout(tool.run(input), TOOL_TIMEOUT_MS);
      if (tool.selfValidate) {
        const out = validate(tool.outputSchema, output);
        if (!out.ok) return text(`service produced invalid output, not charged: ${out.error}`, true);
      }
      return text(output);
    } catch (err: any) {
      return text(`service failed, not charged: ${String(err?.message ?? err).split("\n")[0].slice(0, 240)}`, true);
    }
  })(args, extra);
  const settled = (result._meta as any)?.[MCP_PAYMENT_RESPONSE_META_KEY]?.success === true;
  if (claimed && !settled) {
    replayGuard.release(claimed);
    addSale({ seller: tool.serviceId, payer, amount: "0", status: "failed_not_charged", reason: `MCP: ${result.content?.[0]?.text?.slice(0, 200) ?? "failed"}`, latencyMs: Date.now() - started });
  }
  return result;
}

function buildServer(): Server {
  const mcp = new Server({ name: "gandiva", version: "0.1.0" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...FREE_TOOLS,
      ...paidTools().map((t) => ({
        name: t.name,
        description: `${t.description} Costs ${fromUnits(t.price)} USDC per call (x402, ${NETWORK}), paid to ${t.payTo}.`,
        inputSchema: t.inputSchema as any,
        outputSchema: undefined,
        ...(t.access === "read" ? { annotations: { readOnlyHint: true } } : t.access === "write" ? { annotations: { readOnlyHint: false } } : {}),
      })),
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (FREE_TOOLS.some((t) => t.name === name)) return freeTool(name, args);
    const tool = paidTools().find((t) => t.name === name);
    if (!tool) return text(`unknown tool "${name}"`, true);
    // Bad input is turned away before any payment is asked for.
    const input = structuredClone(args);
    const check = validateInput(tool.inputSchema, input);
    if (!check.ok) return text(`invalid input: ${check.error}`, true);
    const server = await getResourceServer();
    return callPaidTool(server, tool, input, { ...extra, _meta: request.params._meta });
  });
  return mcp;
}

/** POST /mcp: MCP Streamable HTTP, stateless (a fresh server and transport per request). */
export const mcp = new Hono();
mcp.all("/", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer();
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void server.close();
  }
});
