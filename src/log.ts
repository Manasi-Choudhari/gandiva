export type LogLevel = "info" | "warn" | "error";

/** One JSON object per line, so a log search can filter on any field. Never pass headers or bodies: they carry payment signatures. */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
