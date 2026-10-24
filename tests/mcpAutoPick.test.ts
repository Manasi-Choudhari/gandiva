import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import type { BudgetLedger } from "../src/x402/budget.js";
import type { CallResult } from "../src/x402/safePayer.js";
import { SELLER, service } from "./helpers.js";

const fake = vi.hoisted(() => ({ tried: [] as string[], prompts: [] as string[], reply: "" }));

// Buyer agents run for real; only the payment and the model are faked.
vi.mock("../src/x402/safePayer.js", () => ({
  SafePayer: class {
    address = "0x" + "dd".repeat(20);
    async call(s: any, _input: any, ctx: { budget: BudgetLedger }): Promise<CallResult> {
      fake.tried.push(s.id);
      const base = { latencyMs: 5, ledgerId: fake.tried.length, paid: 0n, asked: BigInt(s.price) };
      void ctx;
      return { ...base, status: "failed_not_charged", ok: false, reason: "seller down" } as CallResult;
    }
  },
}));
vi.mock("../src/llm.js", () => ({
  chat: async () => {
    throw new Error("no model in this test");
  },
  chatWith: () => async (messages: { content: string }[]) => {
    fake.prompts.push(messages[0].content);
    return fake.reply;
  },
}));

const { upsertService, setVerification, searchServices, agentMayPick, blindMayPick } = await import("../src/registry/store.js");
const { groupServices } = await import("../src/buyer/catalogue.js");
const { buyCategory, buyOnce, startTask, getRun } = await import("../src/buyer/scout.js");
const { SafePayer } = await import("../src/x402/safePayer.js");

const SCHEMA = { type: "object", required: ["path"], properties: { path: { type: "string" } } };
const OUTPUT = { type: "object", required: ["text"], properties: { text: { type: "string" } } };

function listTool(id: string, access: "read" | "write" | "unknown") {
  upsertService(service({ id, name: id, inputSchema: SCHEMA, outputSchema: OUTPUT, owner: `wallet:${SELLER}`, verification: "verified" }));
  setVerification(id, { verification: "verified", note: "" });
  db.prepare("INSERT INTO mcp_sellers (service_id, owner, server_id, url, tool_name, access) VALUES (?,?,?,?,?,?)").run(id, SELLER, "files", "https://files.example/mcp", id, access);
}

const settle = async (id: string) => {
  await vi.waitFor(() => expect(getRun(id)?.state).not.toBe("running"));
  return getRun(id)!;
};

beforeEach(() => {
  db.exec("DELETE FROM services; DELETE FROM mcp_sellers; DELETE FROM runs");
  fake.tried = [];
  fake.prompts = [];
  fake.reply = JSON.stringify({ final: { answer: "done", outputs: {} } });
  config.buyerPrivateKey = `0x${"11".repeat(32)}`;
  upsertService(service({ id: "plain-seller", name: "plain-seller", inputSchema: SCHEMA, outputSchema: OUTPUT, verification: "verified" }));
  listTool("read-file", "read");
  listTool("delete-file", "write");
  listTool("touch-file", "unknown");
});

describe("what buyer agents may pick by themselves", () => {
  it("agents skip tools that change data, and blind picks also skip tools that do not say", () => {
    const ids = (keep: (s: any) => boolean) => searchServices().filter(keep).map((s) => s.id).sort();
    expect(ids(agentMayPick)).toEqual(["plain-seller", "read-file", "touch-file"]);
    expect(ids(blindMayPick)).toEqual(["plain-seller", "read-file"]);
  });

  it("two MCP tools with the same schema are never the same job, while plain listings still are", () => {
    upsertService(service({ id: "plain-other", name: "plain-other", inputSchema: SCHEMA, outputSchema: OUTPUT }));
    const groups = groupServices(searchServices()).map((g) => g.memberIds.sort());
    expect(groups).toContainEqual(["plain-other", "plain-seller"]);
    for (const id of ["read-file", "delete-file", "touch-file"]) expect(groups).toContainEqual([id]);
  });

  it("Scout's catalogue leaves out a tool that changes data, however well it would fit", async () => {
    const run = startTask({ task: "tidy my files", budget: "0.05", mode: "agent", payer: new SafePayer("0x") as any });
    await settle(run.id);
    expect(fake.prompts[0]).toContain("read-file");
    expect(fake.prompts[0]).toContain("touch-file");
    expect(fake.prompts[0]).not.toContain("delete-file");
  });

  it("Scout cannot reach it by naming it either", async () => {
    fake.reply = JSON.stringify({ calls: [{ service: "delete-file", input: { path: "/a" }, as: "x", purpose: "clean up" }] });
    const run = startTask({ task: "tidy my files", budget: "0.05", mode: "agent", payer: new SafePayer("0x") as any });
    await settle(run.id);
    expect(fake.tried).not.toContain("delete-file");
  });

  it("when a read tool fails, Scout does not fall over to a tool with the same schema", async () => {
    fake.reply = JSON.stringify({ calls: [{ service: "read-file", input: { path: "/a" }, as: "x", purpose: "read" }] });
    const run = startTask({ task: "read my file", budget: "0.05", mode: "agent", payer: new SafePayer("0x") as any });
    await settle(run.id);
    expect(fake.tried.length).toBeGreaterThan(0);
    expect(new Set(fake.tried)).toEqual(new Set(["read-file"]));
  });

  it("a purchase by category only tries listings that are safe to pick blind", async () => {
    await buyCategory({ category: "data", input: { path: "/a" }, budget: "0.05" });
    expect(new Set(fake.tried)).toEqual(new Set(["plain-seller", "read-file"]));
  });

  it("the books pipeline only tries listings that are safe to pick blind", async () => {
    const pick = (id: string, access: "read" | "write" | "unknown") => {
      listTool(id, access);
      db.prepare("UPDATE services SET category = 'scraping' WHERE id = ?").run(id);
    };
    pick("scrape-read", "read");
    pick("scrape-write", "write");
    pick("scrape-unknown", "unknown");
    const run = startTask({ task: "find the 3 cheapest books", budget: "0.05", mode: "legacy", payer: new SafePayer("0x") as any });
    await settle(run.id);
    expect(fake.tried).toContain("scrape-read");
    expect(fake.tried).not.toContain("scrape-write");
    expect(fake.tried).not.toContain("scrape-unknown");
  });

  it("naming the tool yourself still works", async () => {
    await buyOnce({ serviceId: "delete-file", input: { path: "/a" }, budget: "0.05" });
    expect(fake.tried).toEqual(["delete-file"]);
  });
});
