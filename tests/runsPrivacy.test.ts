import { describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { buyer } from "../src/buyer/routes.js";
import { rememberRun, type RunState } from "../src/buyer/scout.js";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const run = (id: string, owner?: string): RunState =>
  ({ id, task: `secret task ${id}`, budget: "50000", maxConcurrency: 3, state: "completed", mode: "agent", dryRun: false, buyer: "0x0", owner, log: [], purchases: [], startedAt: new Date().toISOString() }) as RunState;

rememberRun(run("alice-1", ALICE));
rememberRun(run("bob-1", BOB));
rememberRun(run("anon-1"));

const cookie = (address: string) => ({ cookie: `gandiva_session=${createSession(address).token}` });
const get = (path: string, headers: Record<string, string> = {}) => buyer.request(path, { headers });

describe("runs privacy", () => {
  it("lists only the signed-in user's own runs, and none to a visitor", async () => {
    const mine = await (await get("/runs", cookie(ALICE))).json();
    expect(mine.runs.map((r: any) => r.id)).toEqual(["alice-1"]);
    expect((await (await get("/runs")).json()).runs).toEqual([]);
  });

  it("shows an owned run only to its owner, answering like a missing run otherwise", async () => {
    expect((await get("/runs/alice-1", cookie(ALICE))).status).toBe(200);
    const asBob = await get("/runs/alice-1", cookie(BOB));
    expect(asBob.status).toBe(404);
    expect(await asBob.json()).toEqual({ error: "run not found" });
    expect((await get("/runs/alice-1")).status).toBe(404);
  });

  it("keeps a demo-wallet run readable by its id", async () => {
    expect((await (await get("/runs/anon-1")).json()).task).toBe("secret task anon-1");
    expect((await get("/runs/anon-1", cookie(BOB))).status).toBe(200);
  });
});
