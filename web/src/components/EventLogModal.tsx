import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { api, HttpError } from "../api/client";
import type { APIResponseAttempt, EventLogEntry, UsageEventRecord } from "../api/types";
import { formatTimestamp } from "../lib/utils";

interface Props {
  event: UsageEventRecord;
  onClose: () => void;
}

interface Tab {
  id: string;
  label: string;
  badge?: { text: string; tone: "ok" | "warn" | "danger" | "muted" };
  render: () => React.ReactNode;
}

export default function EventLogModal({ event, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState<EventLogEntry | null>(null);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("info");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setMissing(false);
    setEntry(null);
    setActiveTab("info");
    api
      .eventLog(event.request_id)
      .then((res) => {
        if (cancelled) return;
        if (!res.found || !res.entry) {
          setMissing(true);
        } else {
          setEntry(res.entry);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr(e instanceof HttpError ? e.message : (e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [event.request_id]);

  const tabs: Tab[] = useMemo(() => buildTabs(entry), [entry]);

  // If a previously-selected tab disappears (e.g., entry reloaded with fewer
  // attempts), fall back to the first tab.
  useEffect(() => {
    if (!tabs.length) return;
    if (!tabs.some((t) => t.id === activeTab)) setActiveTab(tabs[0].id);
  }, [tabs, activeTab]);

  const downloadHref = api.eventLogRawURL(event.request_id);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-panel border border-border rounded-lg max-w-5xl w-full h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-baseline gap-3 min-w-0">
            <h2 className="text-sm font-semibold">Request log</h2>
            <span className="font-mono text-xs text-muted truncate">
              {event.request_id}
            </span>
            <span className="text-xs text-muted whitespace-nowrap">
              {formatTimestamp(event.timestamp)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={downloadHref}
              download
              className={clsx(
                "text-xs border border-border rounded px-2 py-1 hover:text-ink",
                (loading || missing) && "opacity-40 pointer-events-none",
              )}
              title="Download raw log file"
            >
              Download
            </a>
            <button
              onClick={onClose}
              className="text-muted hover:text-ink text-lg leading-none px-2"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>

        {loading && (
          <div className="flex-1 grid place-items-center text-muted text-sm">Loading…</div>
        )}
        {!loading && err && (
          <div className="flex-1 grid place-items-center text-danger text-sm px-6 text-center">
            {err}
          </div>
        )}
        {!loading && missing && (
          <div className="flex-1 grid place-items-center text-muted text-sm px-6 text-center">
            No log file found for request id <span className="font-mono mx-1">{event.request_id}</span>.
            Make sure <span className="font-mono mx-1">CPA_LOG_DIR</span> points at the
            directory where CPA writes per-request logs.
          </div>
        )}

        {!loading && entry && tabs.length > 0 && (
          <>
            <nav className="flex items-center gap-1 px-3 pt-2 border-b border-border overflow-x-auto">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={clsx(
                    "text-xs px-3 py-1.5 rounded-t border border-b-0 whitespace-nowrap",
                    activeTab === t.id
                      ? "border-border bg-panel2 text-ink"
                      : "border-transparent text-muted hover:text-ink",
                  )}
                >
                  <span>{t.label}</span>
                  {t.badge && (
                    <span
                      className={clsx(
                        "ml-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-mono",
                        toneClass(t.badge.tone),
                      )}
                    >
                      {t.badge.text}
                    </span>
                  )}
                </button>
              ))}
            </nav>
            <div className="flex-1 min-h-0 p-3">
              {tabs.find((t) => t.id === activeTab)?.render()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function buildTabs(entry: EventLogEntry | null): Tab[] {
  if (!entry) return [];
  const tabs: Tab[] = [];

  tabs.push({
    id: "info",
    label: "Info",
    render: () => (
      <Panel>
        <div className="mb-3">
          <Label>File</Label>
          <div className="font-mono text-[11px] break-all">{entry.file}</div>
        </div>
        <div className="mb-3">
          <Label>Request info</Label>
          <KVList map={entry.info} />
        </div>
        <div>
          <Label>Headers</Label>
          <KVList map={entry.headers} />
        </div>
      </Panel>
    ),
  });

  tabs.push({
    id: "request",
    label: "Request body",
    badge: entry.request_body_truncated
      ? { text: "truncated", tone: "warn" }
      : undefined,
    render: () => (
      <Panel>
        <CodeBlock text={entry.request_body} />
      </Panel>
    ),
  });

  for (const r of entry.api_responses || []) {
    tabs.push({
      id: `api-${r.index}`,
      label: `Response ${r.index}`,
      badge: r.status
        ? { text: String(r.status), tone: statusTone(r.status) }
        : undefined,
      render: () => <APIResponseTab attempt={r} />,
    });
  }

  tabs.push({
    id: "final",
    label: "Final response",
    badge: entry.response_body_truncated
      ? { text: "truncated", tone: "warn" }
      : undefined,
    render: () => (
      <Panel>
        <CodeBlock text={entry.response_body} />
      </Panel>
    ),
  });

  return tabs;
}

function APIResponseTab({ attempt }: { attempt: APIResponseAttempt }) {
  const meta: Record<string, string> = {};
  if (attempt.timestamp) meta.Timestamp = attempt.timestamp;
  if (attempt.status) meta.Status = String(attempt.status);
  return (
    <Panel>
      {Object.keys(meta).length > 0 && (
        <div className="mb-3">
          <Label>Attempt</Label>
          <KVList map={meta} />
        </div>
      )}
      <div className="mb-3">
        <Label>Headers</Label>
        <KVList map={attempt.headers} />
      </div>
      <div>
        <Label>
          Body
          {attempt.body_truncated && (
            <span className="ml-2 text-warn text-[10px] uppercase tracking-wider">
              truncated
            </span>
          )}
        </Label>
        <CodeBlock text={attempt.body} />
      </div>
    </Panel>
  );
}

// Panel is the fixed-height content area. The modal body has h-full, the panel
// fills it, and only this inner container scrolls — keeping the modal frame
// (header + tabs) anchored.
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full bg-panel2 border border-border rounded p-3 overflow-y-auto text-xs">
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">
      {children}
    </div>
  );
}

function KVList({ map }: { map: Record<string, string> }) {
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return <div className="text-muted">—</div>;
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CodeBlock({ text }: { text: string }) {
  const pretty = tryPrettyJson(text);
  return (
    <pre className="bg-panel border border-border rounded p-3 font-mono text-[11px] whitespace-pre-wrap break-words">
      {pretty || <span className="text-muted">—</span>}
    </pre>
  );
}

function statusTone(status: number): "ok" | "warn" | "danger" | "muted" {
  if (status >= 500) return "danger";
  if (status === 429) return "warn";
  if (status >= 400) return "danger";
  if (status >= 200 && status < 300) return "ok";
  return "muted";
}

function toneClass(tone: "ok" | "warn" | "danger" | "muted"): string {
  switch (tone) {
    case "ok":
      return "bg-success/15 text-success";
    case "warn":
      return "bg-warn/15 text-warn";
    case "danger":
      return "bg-danger/15 text-danger";
    default:
      return "bg-panel2 text-muted";
  }
}

// tryPrettyJson reformats whole-text JSON; falls back to the raw text when
// parsing fails (e.g. SSE streams in /v1/responses logs).
function tryPrettyJson(text: string): string {
  const t = text.trim();
  if (!t) return "";
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* fall through */
    }
  }
  return text;
}
