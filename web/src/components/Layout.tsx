import { ReactNode, useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { api } from "../api/client";
import type { DrainStatus, VersionInfo } from "../api/types";
import { formatRelative, isZeroTime } from "../lib/utils";
import { REFRESH_INTERVALS, RefreshInterval, useRefresh } from "../lib/refresh";
import clsx from "clsx";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/analysis", label: "Analysis" },
  { to: "/events", label: "Events" },
  { to: "/credentials", label: "Credentials" },
  { to: "/pricing", label: "Pricing" },
  { to: "/auth-files", label: "Auth Files" },
  { to: "/import", label: "Import" },
];

interface Props {
  children: ReactNode;
  authRequired: boolean;
  onLogout: () => Promise<void>;
}

export default function Layout({ children, authRequired, onLogout }: Props) {
  const [status, setStatus] = useState<DrainStatus | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const { tick } = useRefresh();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.status();
        if (!cancelled) setStatus(s);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await api.version();
        if (!cancelled) setVersion(v);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const drainHealthy =
    status &&
    !status.last_error &&
    !isZeroTime(status.last_pop_at) &&
    Date.now() - new Date(status.last_pop_at).getTime() < 5 * 60_000;

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-border bg-panel">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center gap-6">
          <Link to="/" className="text-lg font-semibold tracking-tight text-ink">
            CPA <span className="text-accent">Usage</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  clsx(
                    "px-3 py-1.5 rounded-md text-muted hover:text-ink hover:bg-panel2 transition-colors",
                    isActive && "bg-panel2 text-ink",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-xs text-muted">
            <RefreshControl />
            <DrainBadge status={status} healthy={!!drainHealthy} />
            {authRequired && (
              <button
                className="px-3 py-1.5 rounded-md border border-border hover:bg-panel2 hover:text-ink"
                onClick={onLogout}
              >
                Logout
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">
        <div className="max-w-[1400px] mx-auto px-6 py-6">{children}</div>
      </main>
      <Footer version={version} />
    </div>
  );
}

function Footer({ version }: { version: VersionInfo | null }) {
  const ours = version?.cpa_usage;
  const cpa = version?.cpa;
  const ourLabel = formatBuild(ours);
  const cpaLabel = formatBuild(cpa);
  return (
    <footer className="border-t border-border bg-panel">
      <div className="max-w-[1400px] mx-auto px-6 py-2 flex items-center gap-4 text-[11px] text-muted">
        <span>
          cpa-usage <span className="font-mono text-ink">{ourLabel || "dev"}</span>
        </span>
        <span className="text-border">·</span>
        <span>
          cpa <span className="font-mono text-ink">{cpaLabel || "—"}</span>
        </span>
      </div>
    </footer>
  );
}

function formatBuild(b?: { version: string; commit: string }) {
  if (!b) return "";
  const v = (b.version || "").trim();
  const c = (b.commit || "").trim();
  if (v && v !== "dev") return v;
  if (c) return c.slice(0, 7);
  return v;
}

function RefreshControl() {
  const { intervalSeconds, setIntervalSeconds, refreshNow } = useRefresh();
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={refreshNow}
        title="Refresh now"
        className="px-2 py-1 rounded-md border border-border hover:bg-panel2 hover:text-ink"
      >
        ↻
      </button>
      <select
        value={intervalSeconds}
        onChange={(e) => setIntervalSeconds(Number(e.target.value) as RefreshInterval)}
        className="bg-panel2 border border-border rounded-md px-2 py-1"
        title="Auto-refresh interval"
      >
        {REFRESH_INTERVALS.map((n) => (
          <option key={n} value={n}>
            {n === 0 ? "auto: off" : `auto: ${n}s`}
          </option>
        ))}
      </select>
    </div>
  );
}

function DrainBadge({ status, healthy }: { status: DrainStatus | null; healthy: boolean }) {
  if (!status) {
    return <span className="text-muted">drain: …</span>;
  }
  return (
    <div className="flex items-center gap-2" title={status.last_error || ""}>
      <span
        className={clsx(
          "inline-block w-2 h-2 rounded-full",
          healthy ? "bg-success" : status.last_error ? "bg-danger" : "bg-warn",
        )}
      />
      <span>
        last pop {formatRelative(status.last_pop_at)} · {status.total_inserted.toLocaleString()} ingested
      </span>
    </div>
  );
}
