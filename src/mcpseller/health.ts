import { canonical } from "../buyer/catalogue.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { getService } from "../registry/store.js";
import { workerTick } from "../workers.js";
import { checkMcpUrl, listRemoteTools, readToken, toolAccess, type RemoteTool } from "./client.js";
import { allMcpTools, cleanSchema, type McpToolRow } from "./servers.js";

const CHECK_EVERY_MS = 30 * 60_000;
/** Soon after boot, because a free-tier host may sleep before a 30-minute timer ever fires. */
const FIRST_CHECK_MS = 30_000;
const MAX_PROBLEM = 300;

const setProblem = db.prepare("UPDATE mcp_sellers SET check_problem = ? WHERE service_id = ?");
const setAccess = db.prepare("UPDATE mcp_sellers SET access = ? WHERE service_id = ?");

/** What is wrong with one listed tool now that the server has answered, or null if nothing is. */
function toolProblem(row: McpToolRow, tool: RemoteTool | undefined): string | null {
  if (!tool) return `${row.toolName} is no longer on the server`;
  const listed = getService(row.serviceId)?.inputSchema;
  return canonical(cleanSchema(tool.inputSchema)) === canonical(listed) ? null : `${row.toolName} takes different input now`;
}

/** Reads one server with its saved token. Only records what it finds: a listing is never removed by a check, because a server can be down for a minute. */
async function checkServer(rows: McpToolRow[]) {
  const { url, tokenEnc } = rows[0];
  let remote: RemoteTool[];
  try {
    remote = await listRemoteTools(await checkMcpUrl(url), readToken(tokenEnc));
  } catch (err: any) {
    const problem = String(err?.message ?? err).slice(0, MAX_PROBLEM);
    db.transaction(() => rows.forEach((r) => setProblem.run(problem, r.serviceId)))();
    return;
  }
  const byName = new Map(remote.map((t) => [t.name, t]));
  db.transaction(() => {
    for (const row of rows) {
      const tool = byName.get(row.toolName);
      setProblem.run(toolProblem(row, tool), row.serviceId);
      // Applied at once, so a tool that starts changing data leaves buyer agents' reach without waiting for the seller.
      if (tool) setAccess.run(toolAccess(tool), row.serviceId);
    }
  })();
}

/** One server at a time, so a large marketplace never opens many connections at once. */
export async function checkServers() {
  const servers = new Map<string, McpToolRow[]>();
  for (const row of allMcpTools()) {
    const key = `${row.owner} ${row.serverId}`;
    servers.set(key, [...(servers.get(key) ?? []), row]);
  }
  for (const rows of servers.values()) await checkServer(rows);
}

let running = false;
/** One pass, unless the last one is still going: slow servers can make a pass outlast the timer. */
export async function runChecks() {
  if (running) return;
  running = true;
  try {
    await checkServers();
    workerTick("mcp-checks");
  } catch (err: any) {
    workerTick("mcp-checks", false);
    log("error", "mcp-checks: pass failed", { error: String(err?.message ?? err) });
  } finally {
    running = false;
  }
}

export function startMcpChecks() {
  setTimeout(runChecks, FIRST_CHECK_MS).unref();
  setInterval(runChecks, CHECK_EVERY_MS).unref();
}
