import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const planner = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock("../src/buyer/agent.js", () => ({ runAgent: planner.runAgent }));

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const payer = { address: "0x1111111111111111111111111111111111111111" } as any;
const dir = mkdtempSync(join(tmpdir(), "gandiva-runs-"));
const opened: { close(): void }[] = [];
let dbNumber = 0;

afterAll(() => {
  opened.forEach((d) => d.close());
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh copy of the modules on the same database file: what a restarted server sees. */
async function boot() {
  vi.resetModules();
  const { db } = await import("../src/db.js");
  opened.push(db);
  return { db, ...(await import("../src/buyer/scout.js")) };
}

const finishWith = (state: string) => async (ctx: any) => {
  Object.assign(ctx.run, { state, result: { answer: "42" }, spent: "1000", remaining: "9000" });
  return { handled: true };
};

const savedState = (db: Awaited<ReturnType<typeof boot>>["db"], id: string) => (db.prepare("SELECT state FROM runs WHERE id = ?").get(id) as { state: string }).state;

beforeEach(() => {
  planner.runAgent.mockReset();
  process.env.DB_PATH = join(dir, `runs-${++dbNumber}.db`);
});

describe("runs outlive a restart", () => {
  it("keeps a finished run readable by id and in its owner's list", async () => {
    planner.runAgent.mockImplementation(finishWith("completed"));
    const before = await boot();
    const { id } = before.startTask({ task: "a task", budget: "0.01", payer, owner: ALICE });
    await vi.waitFor(() => expect(savedState(before.db, id)).toBe("completed"));

    const after = await boot();
    const run = after.getRun(id);
    expect(run).toMatchObject({ id, task: "a task", state: "completed", owner: ALICE, result: { answer: "42" }, spent: "1000" });
    expect(run?.finishedAt).toBeTruthy();
    expect(run).not.toHaveProperty("inflight");
    expect(after.listRuns(ALICE).map((r) => r.id)).toEqual([id]);
    expect(after.listRuns("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toEqual([]);
    expect(after.markInterruptedRuns()).toBe(0);
  });

  it("saves a run that crashes as failed", async () => {
    planner.runAgent.mockRejectedValue(new Error("boom"));
    const before = await boot();
    const { id } = before.startTask({ task: "a task", budget: "0.01", payer });
    await vi.waitFor(() => expect(savedState(before.db, id)).toBe("failed"));
    expect((await boot()).getRun(id)?.log.at(-1)).toContain("fatal: boom");
  });

  it("marks a run cut short as interrupted, with what it spent from the ledger", async () => {
    planner.runAgent.mockReturnValue(new Promise(() => {}));
    const before = await boot();
    const { id } = before.startTask({ task: "a task", budget: "0.01", payer, owner: ALICE });
    const addLedger = before.db.prepare("INSERT INTO ledger (ts,run_id,buyer,seller,service_name,endpoint,listed,paid,status,latency_ms) VALUES ('2026-10-21T00:00:00Z',?,'b','s','n','e','3000',?,?,1)");
    addLedger.run(id, "3000", "paid");
    addLedger.run(id, "2000", "paid_output_rejected");
    addLedger.run(id, "9000", "unconfirmed");
    addLedger.run("another-run", "7000", "paid");

    const after = await boot();
    expect(after.markInterruptedRuns("2026-10-21T01:00:00.000Z")).toBe(1);
    const run = after.getRun(id);
    expect(run).toMatchObject({ state: "interrupted", spent: "5000", remaining: "5000", finishedAt: "2026-10-21T01:00:00.000Z", owner: ALICE });
    expect(run?.explanation).toContain("restarted");
    expect(run?.log.at(-1)).toContain("interrupted");
    expect(after.markInterruptedRuns()).toBe(0);
  });

  it("drops the saved state of the oldest runs past the cap but keeps their rows", async () => {
    planner.runAgent.mockImplementation(finishWith("completed"));
    const before = await boot();
    const add = before.db.prepare("INSERT INTO runs (id, ts, task, budget, state, run_json) VALUES (?,?,'t','1','completed','{}')");
    before.db.transaction(() => {
      for (let i = 0; i < before.MAX_SAVED_RUNS; i++) add.run(`old-${i}`, `2026-01-01T00:00:00.${String(i).padStart(4, "0")}Z`);
    })();

    const { id } = before.startTask({ task: "a task", budget: "0.01", payer });
    await vi.waitFor(() => expect(savedState(before.db, id)).toBe("completed"));

    const saved = before.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE run_json IS NOT NULL").get() as { n: number };
    expect(saved.n).toBe(before.MAX_SAVED_RUNS);
    expect(before.getRun(id)?.state).toBe("completed");
    expect(before.db.prepare("SELECT id FROM runs WHERE id = 'old-0'").get()).toBeTruthy();
    expect(before.getRun("old-0")).toBeUndefined();
  });

  it("adds the new columns to an existing database and keeps its rows", async () => {
    const old = new Database(process.env.DB_PATH!);
    old.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, ts TEXT NOT NULL, task TEXT NOT NULL, budget TEXT NOT NULL, result TEXT);
      INSERT INTO runs (id, ts, task, budget, result) VALUES ('old-run', '2026-10-16T00:00:00Z', 'old task', '1000', '{"state":"completed"}');
    `);
    old.close();

    const { db, getRun, markInterruptedRuns } = await boot();
    expect(db.prepare("SELECT task, result, state, owner, run_json FROM runs WHERE id = 'old-run'").get()).toEqual({
      task: "old task",
      result: '{"state":"completed"}',
      state: null,
      owner: null,
      run_json: null,
    });
    expect(getRun("old-run")).toBeUndefined();
    expect(markInterruptedRuns()).toBe(0);
  });
});
