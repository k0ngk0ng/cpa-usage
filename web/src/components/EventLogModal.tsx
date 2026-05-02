import { useEffect, useState } from "react";
import { api, HttpError } from "../api/client";
import type { EventLogEntry, UsageEventRecord } from "../api/types";
import { formatTimestamp } from "../lib/utils";

interface Props {
  event: UsageEventRecord;
  onClose: () => void;
}

export default function EventLogModal({ event, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState<EventLogEntry | null>(null);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-panel border border-border rounded-lg max-w-5xl w-full max-h-[90vh] flex flex-col"
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
          <button
            onClick={onClose}
            className="text-muted hover:text-ink text-lg leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {loading && <div className="text-muted">Loading…</div>}
          {!loading && err && <div className="text-danger">{err}</div>}
          {!loading && missing && (
            <div className="text-muted">
              No log file found for request id <span className="font-mono">{event.request_id}</span>.
              Make sure <span className="font-mono">CPA_LOG_DIR</span> points at the
              directory where CPA writes per-request logs.
            </div>
          )}
          {!loading && entry && <LogBody entry={entry} />}
        </div>
      </div>
    </div>
  );
}

function LogBody({ entry }: { entry: EventLogEntry }) {
  return (
    <>
      <Section title="File">
        <div className="font-mono text-[11px] break-all">{entry.file}</div>
      </Section>

      <Section title="Request info">
        <KVList map={entry.info} />
      </Section>

      <Section title="Headers" muted>
        <KVList map={entry.headers} />
      </Section>

      <Section
        title="Request body"
        right={entry.request_body_truncated ? <Truncated /> : null}
      >
        <CodeBlock text={entry.request_body} />
      </Section>

      <Section
        title="Response"
        right={entry.response_body_truncated ? <Truncated /> : null}
      >
        <CodeBlock text={entry.response_body} />
      </Section>
    </>
  );
}

function Section({
  title,
  children,
  right,
  muted,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <details open={!muted}>
      <summary className="cursor-pointer flex items-center justify-between text-[11px] uppercase tracking-wider text-muted mb-1.5">
        <span>{title}</span>
        {right}
      </summary>
      <div>{children}</div>
    </details>
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
    <pre className="bg-panel2 border border-border rounded p-3 font-mono text-[11px] whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto">
      {pretty}
    </pre>
  );
}

function Truncated() {
  return (
    <span className="text-warn text-[10px] uppercase tracking-wider">truncated</span>
  );
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
