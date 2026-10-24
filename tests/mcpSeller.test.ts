import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loginMessage } from "../src/auth/session.js";
import { config, NETWORK } from "../src/config.js";
import { db } from "../src/db.js";
import { accept } from "./helpers.js";

const fake = vi.hoisted(() => ({ settleCalls: 0 }));

// The paid route runs for real; only the facilitator is faked (requirements follow the route's own payTo and price).
vi.mock("../src/x402/resourceServer.js", async () => {
  const { accept } = await import("./helpers.js");
  return {
    getResourceServer: async () => ({
      buildPaymentRequirements: async (o: any) => accept({ payTo: o.payTo, amount: o.price.amount }),
      createPaymentRequiredResponse: async (reqs: unknown, resource: unknown, error: string) => ({ x402Version: 2, error, resource, accepts: [reqs] }),
      findMatchingRequirements: (reqs: any) => reqs[0] ?? reqs,
      verifyPayment: async () => ({ isValid: true }),
      settlePayment: async () => {
        fake.settleCalls++;
        return { success: true, transaction: "0x" + "ab".repeat(32), network: NETWORK, payer: "0x" + "99".repeat(20) };
      },
    }),
  };
});
// No real DNS: "intranet" hosts resolve to a private address, everything else to a public one.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => [{ address: host.startsWith("intranet") ? "10.0.0.5" : "93.184.216.34", family: 4 }],
}));

const { auth } = await import("../src/auth/routes.js");
const { registry } = await import("../src/registry/routes.js");
const { buildSellers } = await import("../src/sellers/index.js");
const { mcp } = await import("../src/mcp/server.js");
const { getService } = await import("../src/registry/store.js");
const { getMcpTool, resetServerChecks } = await import("../src/mcpseller/servers.js");

const ORIGIN = "http://localhost:3000";
const KEY = "ab".repeat(32);
const URL1 = "https://mcp.sellerco.example/mcp";
const URL2 = "https://other.example/mcp";
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
// A made-up token, generated per run so no key-like string lives in the repo (gitleaks runs over it).
const TOKEN = `test-${generatePrivateKey().slice(2, 26)}`;

async function loginCookie(account: typeof alice) {
  const { nonce } = (await (await auth.request("/nonce")).json()) as { nonce: string };
  const message = loginMessage({ address: account.address, nonce, issuedAt: new Date().toISOString(), uri: ORIGIN });
  const res = await auth.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

const send = (method: string, path: string, cookie?: string, body?: unknown) =>
  registry.request(path, { method, headers: { ...(cookie ? { cookie } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const picks = (names: string[], price = "2000") => names.map((name) => ({ name, price }));
const form = (over: Record<string, unknown> = {}) => ({ url: URL1, token: TOKEN, category: "data", tools: picks(["echo", "shout"]), ...over });
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
const save = (cookie: string | undefined, body: unknown) => send("POST", "/mine/mcp-servers", cookie, body);
const loadTools = (cookie: string | undefined, body: unknown) => send("POST", "/mine/mcp-servers/tools", cookie, body);

// The seller app (MCP tool route included) mounted the way server.ts mounts it.
const { app: sellersApp } = buildSellers();
const server = new Hono().route("/sellers", sellersApp);

interface FakeTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}
const echoTool = (over: Partial<FakeTool> = {}): FakeTool => ({
  name: "echo",
  description: "Echoes the text back.",
  inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { text: { type: "string", description: "x".repeat(900) } }, required: ["text"] },
  ...over,
});

let aliceCookie: string;
let bobCookie: string;
let remoteTools: FakeTool[];
let remoteCall: (name: string, args: Record<string, unknown>) => any;
let remoteRequests: { url: string; authorization: string | null; method: string; rpc?: string }[];

/** A real MCP server (SDK, Streamable HTTP, stateless) standing in for the seller's server. */
async function fakeMcp(req: Request): Promise<Response> {
  const s = new Server({ name: "fake-seller-server", version: "1.0.0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: remoteTools as any }));
  s.setRequestHandler(CallToolRequestSchema, async (r) => remoteCall(r.params.name, (r.params.arguments ?? {}) as Record<string, unknown>));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await s.connect(transport);
  return transport.handleRequest(req);
}

const paymentHeader = (nonce: string) =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: accept(),
    payload: { signature: "0x00", authorization: { from: "0x" + "99".repeat(20), to: alice.address, value: "2000", validAfter: "0", validBefore: "9999999999", nonce } },
  } as any);
const callTool = (id: string, args: unknown, nonce?: string) =>
  server.request(`/sellers/u/${id}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(nonce ? { "PAYMENT-SIGNATURE": paymentHeader(nonce) } : {}) },
    body: JSON.stringify(args),
  });

beforeEach(async () => {
  config.secretsKey = KEY;
  db.exec("DELETE FROM services; DELETE FROM mcp_sellers; DELETE FROM hosted_sellers; DELETE FROM sessions; DELETE FROM auth_nonces; DELETE FROM nonces; DELETE FROM sales");
  fake.settleCalls = 0;
  resetServerChecks();
  remoteTools = [echoTool(),echoTool({ name: "shout", description: "Upper-cases the text." })];
  remoteCall = (name, args) => ({ content: [{ type: "text", text: `${name}: ${String(args.text)}` }] });
  remoteRequests = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: any, init: any = {}) => {
    const url = String(input);
    if (/^https:\/\/(mcp\.sellerco|other)\.example\//.test(url)) {
      const req = new Request(url, init);
      let rpc: string | undefined;
      try {
        rpc = (await req.clone().json()).method;
      } catch {
        /* GET or no body */
      }
      remoteRequests.push({ url, authorization: req.headers.get("authorization"), method: req.method, rpc });
      return fakeMcp(req);
    }
    // The probe of our own MCP-tool route over loopback.
    return server.request(new URL(url).pathname, init);
  }) as any);
  aliceCookie = await loginCookie(alice);
  bobCookie = await loginCookie(bob);
});
afterEach(() => vi.restoreAllMocks());

describe("MCP server template: loading tools", () => {
  it("needs a sign-in", async () => {
    expect((await loadTools(undefined, { url: URL1 })).status).toBe(401);
    expect((await save(undefined, form())).status).toBe(401);
  });

  it("shows the server's tools without listing anything", async () => {
    const res = await loadTools(aliceCookie, { url: URL1, token: TOKEN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("sellerco");
    expect(body.tools.map((t: any) => t.name)).toEqual(["echo", "shout"]);
    expect(body.tools[0]).toMatchObject({ description: "Echoes the text back.", usable: true, access: "unknown", listedPrice: null });
    expect(getService("sellerco-echo")).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("sends the token as a bearer header and the SDK negotiates a normal MCP session", async () => {
    await loadTools(aliceCookie, { url: URL1, token: TOKEN });
    expect(remoteRequests.map((r) => r.rpc).filter(Boolean)).toEqual(expect.arrayContaining(["initialize", "tools/list"]));
    expect(remoteRequests.filter((r) => r.method === "POST").every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("rejects private, plain-http and malformed URLs", async () => {
    for (const url of ["https://intranet.example/mcp", "http://mcp.sellerco.example/mcp", "https://127.0.0.1/mcp", "not a url"]) {
      expect((await loadTools(aliceCookie, { url })).status, url).toBe(400);
      expect((await save(aliceCookie, form({ url }))).status, url).toBe(400);
    }
    expect(remoteRequests).toHaveLength(0);
  });

  it("says so when the server cannot be reached or has no tools", async () => {
    remoteTools = [];
    expect((await save(aliceCookie, form())).status).toBe(400);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(`connect ECONNREFUSED ${TOKEN}`));
    const res = await loadTools(aliceCookie, { url: URL1, token: TOKEN });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("allows 20 server checks per hour per wallet", async () => {
    for (let i = 0; i < 20; i++) expect((await loadTools(aliceCookie, { url: URL1 })).status).toBe(200);
    expect((await loadTools(aliceCookie, { url: URL1 })).status).toBe(429);
    expect((await loadTools(bobCookie, { url: URL1 })).status).toBe(200);
  });
});

describe("MCP server template: listing", () => {
  it("lists each picked tool as its own paid listing that pays the signed-in wallet, verified by the registry's own probe", async () => {
    const res = await save(aliceCookie, form());
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.listed.map((s: any) => s.id)).toEqual(["sellerco-echo", "sellerco-shout"]);
    expect(body.skipped).toEqual([]);
    expect(body.hasToken).toBe(true);
    expect(body.listed[0]).toMatchObject({ category: "data", method: "POST", payTo: alice.address.toLowerCase(), price: "2000", verification: "verified" });
    expect(body.listed[0].endpoint).toBe(`${config.publicBaseUrl}/sellers/u/sellerco-echo/call`);
    expect(body.listed[0].description).toContain("MCP tool from mcp.sellerco.example");
  });

  it("stores a cleaned snapshot of each tool's input schema", async () => {
    await save(aliceCookie, form());
    const schema = getService("sellerco-echo")!.inputSchema as any;
    expect(schema.$schema).toBeUndefined();
    expect(schema.required).toEqual(["text"]);
    expect(schema.properties.text.description).toHaveLength(500);
  });

  it("stores the token encrypted and never sends it back", async () => {
    await save(aliceCookie, form());
    const rows = db.prepare("SELECT * FROM mcp_sellers").all() as any[];
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(rows[0].token_enc).toMatch(/^v1:/);
    const mine = await (await send("GET", "/mine", aliceCookie)).text();
    expect(mine).not.toContain(TOKEN);
    expect(JSON.parse(mine).mcp["sellerco-echo"]).toEqual({ serverId: "sellerco", url: URL1, tool: "echo", hasToken: true });
    expect(await (await send("GET", "/services/sellerco-echo")).text()).not.toContain(TOKEN);
  });

  it("needs SECRETS_KEY only when there is a token to keep", async () => {
    config.secretsKey = "";
    const withToken = await save(aliceCookie, form());
    expect(withToken.status).toBe(503);
    expect(((await withToken.json()) as any).error).toMatch(/SECRETS_KEY/);
    expect((await save(aliceCookie, form({ token: undefined }))).status).toBe(201);
    expect(getMcpTool("sellerco-echo")!.tokenEnc).toBeNull();
  });

  it("refreshing keeps the saved token, adds picked tools and removes the ones the server dropped", async () => {
    await save(aliceCookie, form());
    const first = getMcpTool("sellerco-echo")!.tokenEnc;
    remoteTools = [echoTool(), echoTool({ name: "whisper" })];
    const res = await save(aliceCookie, form({ token: undefined, tools: picks(["echo", "whisper"], "3000") }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.listed.map((s: any) => s.id)).toEqual(["sellerco-echo", "sellerco-whisper"]);
    expect(body.removed).toEqual(["sellerco-shout"]);
    expect(getService("sellerco-shout")).toBeUndefined();
    expect(getMcpTool("sellerco-shout")).toBeUndefined();
    expect(getMcpTool("sellerco-echo")!.tokenEnc).toBe(first);
    expect(getService("sellerco-echo")!.price).toBe("3000");
    expect(remoteRequests.filter((r) => r.rpc === "initialize").at(-1)!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("never sends a saved token to a different URL", async () => {
    await save(aliceCookie, form());
    remoteRequests = [];
    const res = await save(aliceCookie, form({ url: URL2, token: undefined, name: "other" }));
    expect(res.status).toBe(201);
    expect(remoteRequests.length).toBeGreaterThan(0);
    expect(remoteRequests.every((r) => r.authorization === null)).toBe(true);
    expect(getMcpTool("other-echo")!.tokenEnc).toBeNull();
  });

  it("lists at most 20 tools per wallet and says which were left out", async () => {
    await send("POST", "/mine/services", aliceCookie, { name: "mine-one", category: "data", endpoint: "https://seller.example/x", price: "1500", inputSchema: { type: "object" }, outputSchema: { type: "object" } });
    remoteTools = Array.from({ length: 25 }, (_, i) => echoTool({ name: `t${i}` }));
    const body = (await (await save(aliceCookie, form({ tools: picks(numbered(20)) }))).json()) as any;
    expect(body.listed).toHaveLength(19);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toMatch(/limit/);
  });

  it("lists only the picked tools, each at its own price", async () => {
    const body = (await (await save(aliceCookie, form({ tools: [{ name: "shout", price: "7000" }] }))).json()) as any;
    expect(body.listed.map((s: any) => s.id)).toEqual(["sellerco-shout"]);
    expect(body.skipped).toEqual([]);
    expect(getService("sellerco-echo")).toBeUndefined();
    expect(getService("sellerco-shout")!.price).toBe("7000");
    const asked = await callTool("sellerco-shout", { text: "hi" });
    expect(((await asked.json()) as any).accepts[0]).toMatchObject({ amount: "7000" });
  });

  it("unticking a tool takes it off the marketplace, and it stays off on the next save", async () => {
    await save(aliceCookie, form());
    const body = (await (await save(aliceCookie, form({ token: undefined, tools: picks(["echo"]) }))).json()) as any;
    expect(body.removed).toEqual(["sellerco-shout"]);
    expect(getService("sellerco-shout")).toBeUndefined();
    expect(getMcpTool("sellerco-shout")).toBeUndefined();
    await save(aliceCookie, form({ token: undefined, tools: picks(["echo"], "2500") }));
    expect(getService("sellerco-shout")).toBeUndefined();
    expect(getService("sellerco-echo")!.price).toBe("2500");
  });

  it("frees an unticked tool's slot before listing a new one, even at the wallet's limit", async () => {
    remoteTools = Array.from({ length: 21 }, (_, i) => echoTool({ name: `t${i}` }));
    await save(aliceCookie, form({ tools: picks(numbered(20)) }));
    const body = (await (await save(aliceCookie, form({ token: undefined, tools: picks(numbered(20).map((_, i) => `t${i + 1}`)) }))).json()) as any;
    expect(body.removed).toEqual(["sellerco-t0"]);
    expect(body.skipped).toEqual([]);
    expect(getService("sellerco-t20")).toBeDefined();
  });

  it("a save that lists nothing changes nothing", async () => {
    await save(aliceCookie, form());
    const res = await save(aliceCookie, form({ token: undefined, tools: picks(["gone"]) }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("gone (the server no longer offers it)");
    expect(getService("sellerco-echo")).toBeDefined();
    expect(getMcpTool("sellerco-shout")).toBeDefined();
  });

  it("says which picked tools the server no longer offers", async () => {
    const body = (await (await save(aliceCookie, form({ tools: picks(["echo", "gone"]) }))).json()) as any;
    expect(body.listed.map((s: any) => s.id)).toEqual(["sellerco-echo"]);
    expect(body.skipped).toEqual([{ tool: "gone", reason: "the server no longer offers it" }]);
  });

  it("refuses bad picks", async () => {
    for (const tools of [[], picks(["echo", "echo"]), picks(numbered(21)), picks(["echo"], "0"), picks(["echo"], "100001"), undefined]) {
      expect((await save(aliceCookie, form({ tools }))).status, JSON.stringify(tools)).toBe(400);
    }
    expect(getService("sellerco-echo")).toBeUndefined();
  });

  it("shows what is already on sale, at its current price, when the server is read again", async () => {
    await save(aliceCookie, form({ tools: [{ name: "echo", price: "4000" }] }));
    const byUrl = (await (await loadTools(aliceCookie, { url: URL1 })).json()) as any;
    expect(byUrl.tools.map((t: any) => t.listedPrice)).toEqual(["4000", null]);
    const byGroup = (await (await loadTools(aliceCookie, { url: URL2, serverId: "sellerco" })).json()) as any;
    expect(byGroup.tools[0].listedPrice).toBe("4000");
    const bobs = (await (await loadTools(bobCookie, { url: URL1, serverId: "sellerco" })).json()) as any;
    expect(bobs.tools.every((t: any) => t.listedPrice === null)).toBe(true);
  });

  it("reports what each tool's hints say", async () => {
    remoteTools = [
      echoTool({ name: "reads", annotations: { readOnlyHint: true, destructiveHint: true } }),
      echoTool({ name: "adds", annotations: { readOnlyHint: false, destructiveHint: false } }),
      echoTool({ name: "wipes", annotations: { destructiveHint: true } }),
      echoTool({ name: "open", annotations: {} }),
      echoTool({ name: "bare" }),
    ];
    const body = (await (await loadTools(aliceCookie, { url: URL1 })).json()) as any;
    expect(Object.fromEntries(body.tools.map((t: any) => [t.name, t.access]))).toEqual({ reads: "read", adds: "write", wipes: "write", open: "unknown", bare: "unknown" });
  });

  it("will not let a second server take over a group by sharing its name", async () => {
    await save(aliceCookie, form());
    const res = await save(aliceCookie, form({ url: URL2, name: "sellerco", token: undefined }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain(URL1);
    expect(getMcpTool("sellerco-echo")!.url).toBe(URL1);
    expect(getMcpTool("sellerco-shout")).toBeDefined();
  });

  it("Refresh may move a group to a new URL, and the old token does not follow it", async () => {
    await save(aliceCookie, form());
    const res = await save(aliceCookie, form({ url: URL2, name: "sellerco", token: undefined, changeUrl: true }));
    expect(res.status).toBe(201);
    expect(getMcpTool("sellerco-echo")).toMatchObject({ url: URL2, tokenEnc: null });
  });

  it("skips a tool whose id is already one of the wallet's other listings, without touching that listing", async () => {
    await send("POST", "/mine/services", aliceCookie, {
      name: "sellerco-echo", category: "data", endpoint: "https://seller.example/x", price: "1500", inputSchema: { type: "object" }, outputSchema: { type: "object" },
    });
    const body = (await (await save(aliceCookie, form())).json()) as any;
    expect(body.listed.map((s: any) => s.id)).toEqual(["sellerco-shout"]);
    expect(body.skipped[0]).toMatchObject({ tool: "echo" });
    expect(getService("sellerco-echo")!.endpoint).toBe("https://seller.example/x");
  });

  it("the own-endpoint form cannot overwrite an MCP tool", async () => {
    await save(aliceCookie, form());
    const res = await send("POST", "/mine/services", aliceCookie, {
      name: "sellerco-echo", category: "data", endpoint: "https://seller.example/x", price: "1500", inputSchema: { type: "object" }, outputSchema: { type: "object" },
    });
    expect(res.status).toBe(409);
    expect(getService("sellerco-echo")!.endpoint).toContain("/sellers/u/sellerco-echo/call");
  });

  it("another wallet cannot take or delete the tools; deleting removes the stored settings", async () => {
    await save(aliceCookie, form());
    const taken = await save(bobCookie, form({ token: undefined })); // the ids are alice's: nothing of bob's can be listed under them
    expect(taken.status).toBe(400);
    expect(((await taken.json()) as any).error).toMatch(/already listed by someone else/);
    expect(getService("sellerco-echo")!.owner).toBe(`wallet:${alice.address.toLowerCase()}`);
    expect((await save(bobCookie, form({ token: undefined, name: "bobs" }))).status).toBe(201);
    expect((await send("DELETE", "/mine/services/sellerco-echo", bobCookie)).status).toBe(403);
    expect(getMcpTool("sellerco-echo")).toBeDefined();
    expect((await send("DELETE", "/mine/services/sellerco-echo", aliceCookie)).status).toBe(200);
    expect(getMcpTool("sellerco-echo")).toBeUndefined();
    expect((await callTool("sellerco-echo", { text: "hi" })).status).toBe(404);
  });
});

describe("MCP server template: free test calls", () => {
  const test_ = (cookie: string | undefined, body: unknown) => send("POST", "/mine/mcp-servers/test", cookie, body);
  const trial = (over: Record<string, unknown> = {}) => ({ url: URL1, token: TOKEN, tool: "echo", input: { text: "hi" }, ...over });

  it("needs a sign-in", async () => {
    expect((await test_(undefined, trial())).status).toBe(401);
    expect(remoteRequests).toHaveLength(0);
  });

  it("runs the tool on the seller's server without listing, paying or recording anything", async () => {
    const res = await test_(aliceCookie, trial());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.text).toBe("echo: hi");
    expect(body.ms).toEqual(expect.any(Number));
    expect(remoteRequests.filter((r) => r.rpc === "tools/call")).toHaveLength(1);
    expect(remoteRequests.filter((r) => r.method === "POST").every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(fake.settleCalls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sales").get()).toEqual({ n: 0 });
    expect(getService("sellerco-echo")).toBeUndefined();
  });

  it("gives a sample input for each tool to start from", async () => {
    const body = (await (await loadTools(aliceCookie, { url: URL1 })).json()) as any;
    expect(body.tools[0].sample).toEqual({ text: "sample text" });
  });

  it("uses a saved token only for its exact URL", async () => {
    await save(aliceCookie, form());
    remoteRequests = [];
    expect((await test_(aliceCookie, trial({ token: undefined }))).status).toBe(200);
    expect(remoteRequests.filter((r) => r.method === "POST").every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    remoteRequests = [];
    expect((await test_(aliceCookie, trial({ token: undefined, url: URL2 }))).status).toBe(200);
    expect(remoteRequests.every((r) => r.authorization === null)).toBe(true);
    remoteRequests = [];
    expect((await test_(bobCookie, trial({ token: undefined }))).status).toBe(200);
    expect(remoteRequests.every((r) => r.authorization === null)).toBe(true);
  });

  it("checks the input the way a paid call does, before the tool runs", async () => {
    const res = await test_(aliceCookie, trial({ input: { nope: 1 } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/invalid input/);
    expect(remoteRequests.filter((r) => r.rpc === "tools/call")).toHaveLength(0);
  });

  it("refuses a tool the server does not have, and private addresses", async () => {
    expect((await test_(aliceCookie, trial({ tool: "nope" }))).status).toBe(400);
    expect(remoteRequests.filter((r) => r.rpc === "tools/call")).toHaveLength(0);
    remoteRequests = [];
    expect((await test_(aliceCookie, trial({ url: "https://intranet.example/mcp" }))).status).toBe(400);
    expect(remoteRequests).toHaveLength(0);
  });

  it("reports a tool failure without leaking the token", async () => {
    remoteCall = () => ({ isError: true, content: [{ type: "text", text: `bad token ${TOKEN}` }] });
    const res = await test_(aliceCookie, trial());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("the tool reported an error");
    expect(text).not.toContain(TOKEN);
  });

  it("allows 20 test calls per hour per wallet, counted apart from server checks", async () => {
    for (let i = 0; i < 20; i++) expect((await test_(aliceCookie, trial())).status).toBe(200);
    expect((await test_(aliceCookie, trial())).status).toBe(429);
    expect((await test_(bobCookie, trial())).status).toBe(200);
    expect((await loadTools(aliceCookie, { url: URL1 })).status).toBe(200);
  });

  it("refuses an oversized request", async () => {
    expect((await test_(aliceCookie, trial({ input: { text: "x".repeat(40_000) } }))).status).toBe(413);
    expect(remoteRequests).toHaveLength(0);
  });
});

describe("MCP server template: the paid route", () => {
  beforeEach(async () => {
    await save(aliceCookie, form());
    remoteRequests = [];
  });

  it("asks for payment first, and the 402 pays the seller's wallet the listed price", async () => {
    const res = await callTool("sellerco-echo", { text: "hi" });
    expect(res.status).toBe(402);
    expect(remoteRequests).toHaveLength(0);
    expect(((await res.json()) as any).accepts[0]).toMatchObject({ payTo: alice.address.toLowerCase(), amount: "2000" });
  });

  it("turns bad input away before asking for payment", async () => {
    expect((await callTool("sellerco-echo", { nope: 1 })).status).toBe(400);
    expect(remoteRequests).toHaveLength(0);
  });

  it("after payment calls the tool on the seller's server with their token, then settles once and records the sale", async () => {
    const res = await callTool("sellerco-echo", { text: "hello" }, "0x" + "01".repeat(32));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "echo: hello" });
    expect(fake.settleCalls).toBe(1);
    expect(remoteRequests.filter((r) => r.rpc === "tools/call")).toHaveLength(1);
    expect(remoteRequests.filter((r) => r.method === "POST").every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(db.prepare("SELECT seller, status, amount FROM sales").all()).toEqual([{ seller: "sellerco-echo", status: "paid", amount: "2000" }]);
  });

  it("passes the tool's structured result along when it has one", async () => {
    remoteCall = () => ({ content: [{ type: "text", text: "42" }], structuredContent: { answer: 42 } });
    const res = await callTool("sellerco-echo", { text: "x" }, "0x" + "02".repeat(32));
    expect(await res.json()).toEqual({ text: "42", structuredContent: { answer: 42 } });
  });

  it("the same payment cannot be used twice", async () => {
    const nonce = "0x" + "03".repeat(32);
    expect((await callTool("sellerco-echo", { text: "a" }, nonce)).status).toBe(200);
    expect((await callTool("sellerco-echo", { text: "a" }, nonce)).status).toBe(409);
    expect(fake.settleCalls).toBe(1);
  });

  it.each([
    ["the tool reports an error", () => ({ isError: true, content: [{ type: "text", text: `bad token ${TOKEN}` }] })],
    ["the tool returns nothing", () => ({ content: [] })],
    ["the tool returns too much", () => ({ content: [{ type: "text", text: "y".repeat(60_000) }] })],
    ["the tool crashes", () => Promise.reject(new Error("boom"))],
  ])("%s: the buyer is not charged", async (_why, reply) => {
    remoteCall = reply as any;
    const res = await callTool("sellerco-echo", { text: "hello" }, "0x" + "04".repeat(32));
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.charged).toBe(false);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(fake.settleCalls).toBe(0);
    expect((db.prepare("SELECT status FROM sales").get() as any).status).toBe("failed_not_charged");
    // the same authorization may be tried again, because nothing was settled
    remoteCall = (n, a) => ({ content: [{ type: "text", text: `${n}: ${a.text}` }] });
    expect((await callTool("sellerco-echo", { text: "hello" }, "0x" + "04".repeat(32))).status).toBe(200);
  });

  it("refuses to call a server that now points at a private address", async () => {
    db.prepare("UPDATE mcp_sellers SET url = 'https://intranet.example/mcp'").run();
    const res = await callTool("sellerco-echo", { text: "hello" }, "0x" + "05".repeat(32));
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toMatch(/not allowed/);
    expect(fake.settleCalls).toBe(0);
  });
});

describe("MCP server template: our own /mcp", () => {
  it("also offers the seller's tools, at their price and payTo", async () => {
    await save(aliceCookie, form());
    const res = await mcp.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = ((await res.json()) as any).result.tools as { name: string; description: string }[];
    const echo = tools.find((t) => t.name === "sellerco_echo");
    expect(echo?.description).toContain("0.002000 USDC");
    expect(echo?.description).toContain(alice.address.toLowerCase());
    expect(tools.some((t) => t.name === "sellerco_shout")).toBe(true);
  });
});
