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
  { to: "/sessions", label: "Sessions" },
  { to: "/credentials", label: "Credentials" },
  { to: "/pricing", label: "Pricing" },
  { to: "/aliases", label: "Aliases" },
  { to: "/auth-files", label: "Auth Files" },
  { to: "/import", label: "Migration" },
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
    (status.redis_mode === "subscribe" ||
      (!isZeroTime(status.last_pop_at) &&
        Date.now() - new Date(status.last_pop_at).getTime() < 5 * 60_000));

  return (
    <div className="min-h-full min-w-0 flex flex-col">
      <header className="border-b border-border bg-panel">
        <div className="max-w-[1400px] mx-auto px-4 py-3 sm:px-6 sm:py-4 flex flex-wrap items-center gap-x-3 gap-y-3 lg:flex-nowrap lg:gap-3">
          <Link to="/" className="shrink-0 whitespace-nowrap text-lg font-semibold tracking-tight text-ink">
            CPA <span className="text-accent">Usage</span>
          </Link>
          <nav className="order-3 grid w-full grid-cols-4 gap-1 text-[11px] lg:order-none lg:flex lg:w-auto lg:items-center lg:text-sm">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  clsx(
                    "min-w-0 truncate rounded-md px-0.5 py-1.5 text-center text-muted transition-colors hover:bg-panel2 hover:text-ink lg:px-2",
                    isActive && "bg-panel2 text-ink",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted sm:gap-4">
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
      <main className="min-w-0 flex-1 pb-10">
        <div className="max-w-[1400px] min-w-0 mx-auto px-4 py-4 sm:px-6 sm:py-6">{children}</div>
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
    <footer className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-panel/95 backdrop-blur">
      <div className="max-w-[1400px] mx-auto px-4 py-2 sm:px-6 flex items-center gap-4 text-[11px] text-muted">
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
    return (
      <span
        role="status"
        className="inline-block h-2 w-2 rounded-full bg-muted"
        aria-label="Drain status loading"
        title="Drain status loading"
      />
    );
  }
  return (
    <div
      role="status"
      className="flex items-center gap-2"
      aria-label={`Drain ${status.redis_mode || "queue"}; last receive ${formatRelative(status.last_pop_at)}; ${status.total_inserted.toLocaleString()} ingested`}
      title={status.last_error || ""}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "inline-block w-2 h-2 rounded-full",
          healthy ? "bg-success" : status.last_error ? "bg-danger" : "bg-warn",
        )}
      />
      <span className="hidden xl:inline">
        {status.redis_mode || "queue"} · last receive {formatRelative(status.last_pop_at)} ·{" "}
        {status.total_inserted.toLocaleString()} ingested
      </span>
    </div>
  );
}
