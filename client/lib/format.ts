/** Services whose 402/payTo/output is deliberately hostile, for the demo. */
export const ADVERSARIAL_IDS = new Set(["cheap-scraper", "mirror-scraper", "junk-fx"]);

/** USDC smallest units (6 decimals) -> trimmed human string. */
export function usdc(units?: string | number | null): string {
  if (units === null || units === undefined) return "0";
  const n = Number(units) / 1e6;
  if (!Number.isFinite(n)) return "0";
  return n
    .toFixed(6)
    .replace(/\.?0+$/, "")
    .replace(/^$/, "0");
}

export function short(addr?: string | null): string {
  if (!addr) return "—";
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function explorerTx(hash?: string | null): string | null {
  return hash ? `https://sepolia.basescan.org/tx/${hash}` : null;
}

export function explorerAddress(addr?: string | null): string | null {
  return addr ? `https://sepolia.basescan.org/address/${addr}` : null;
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** "2026-10-16T19:35:00.000Z" -> "10-16 19:35:00" */
export function clock(ts?: string | null): string {
  if (!ts) return "";
  return ts.slice(5, 19).replace("T", " ");
}

/** ISO timestamp -> "12s ago", "4m ago", "3h ago", "2d ago". */
export function ago(ts: string | null | undefined, now: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function stars(n: number): string {
  return "★".repeat(Math.max(0, Math.min(5, n)));
}

export function statusLabel(status: string): string {
  switch (status) {
    case "paid":
      return "paid";
    case "paid_output_rejected":
      return "paid, output rejected";
    case "failed_not_charged":
      return "failed, not charged";
    case "unconfirmed":
      return "unconfirmed, checking chain";
    case "refused":
      return "refused";
    case "replay_rejected":
      return "replay rejected";
    default:
      return status.replace(/_/g, " ");
  }
}

/** "0.0015" -> "1500" (USDC smallest units, 6 decimals); null when it is not a plain decimal number with at most 6 decimals. */
export function toUnits(input: string): string | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) return null;
  const units = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0") || "0");
  return Number.isSafeInteger(units) ? String(units) : null;
}
