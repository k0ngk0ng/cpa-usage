export function formatNumber(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "0";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 10_000) return (n / 1000).toFixed(1) + "K";
  return n.toLocaleString();
}

export function formatTokens(n: number | undefined | null): string {
  return formatNumber(n ?? 0);
}

export function formatCost(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "$0.00";
  if (Math.abs(n) >= 1) return "$" + n.toFixed(2);
  if (Math.abs(n) >= 0.01) return "$" + n.toFixed(4);
  return "$" + n.toExponential(2);
}

export function formatLatency(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(2) + "s";
  return (ms / 60_000).toFixed(2) + "m";
}

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} ${units[unit]}`;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatTimestamp(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

export function formatRelative(iso: string | undefined | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const t = d.getTime();
  if (t <= 0) return "never";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  if (diff < 60_000) return Math.round(diff / 1000) + "s ago";
  if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "h ago";
  return Math.round(diff / 86_400_000) + "d ago";
}

export function pct(num: number, denom: number): string {
  if (!denom) return "—";
  return ((num / denom) * 100).toFixed(1) + "%";
}

export function isZeroTime(iso: string | undefined | null): boolean {
  if (!iso) return true;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getTime() <= 0;
}
