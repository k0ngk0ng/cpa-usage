import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, HttpError } from "../api/client";
import type { APIResponseAttempt, EventLogEntry, UsageEventRecord } from "../api/types";
import { formatBytes, formatCost, formatLatency, formatNumber, formatTimestamp } from "../lib/utils";
import {
  extractRequestTurns,
  extractRequestToolDeclarations,
  extractResponseJSON,
  extractResponseStream,
  isSafeDataImageURL,
  streamToMarkdown,
} from "../lib/protocol";
import type { StreamExtraction, Turn } from "../lib/protocol";

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

interface ModalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ModalInteraction =
  | { kind: "drag"; startX: number; startY: number; startRect: ModalRect }
  | { kind: "resize"; startX: number; startY: number; startRect: ModalRect };

export default function EventLogModal({ event, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState<EventLogEntry | null>(null);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("info");
  const [rect, setRect] = useState<ModalRect>(() => initialModalRect());
  const interactionRef = useRef<ModalInteraction | null>(null);
  const bodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const beginPointerInteraction = useCallback((cursor: string) => {
    if (typeof document === "undefined" || bodyStyleRef.current) return;
    bodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
  }, []);

  const endPointerInteraction = useCallback(() => {
    if (typeof document === "undefined" || !bodyStyleRef.current) return;
    document.body.style.cursor = bodyStyleRef.current.cursor;
    document.body.style.userSelect = bodyStyleRef.current.userSelect;
    bodyStyleRef.current = null;
  }, []);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) return;
      const dx = e.clientX - interaction.startX;
      const dy = e.clientY - interaction.startY;
      if (interaction.kind === "drag") {
        setRect({
          ...interaction.startRect,
          x: interaction.startRect.x + dx,
          y: interaction.startRect.y + dy,
        });
      } else {
        setRect(
          applyModalMinSize({
            ...interaction.startRect,
            width: interaction.startRect.width + dx,
            height: interaction.startRect.height + dy,
          }),
        );
      }
    };
    const onPointerUp = () => {
      interactionRef.current = null;
      endPointerInteraction();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      endPointerInteraction();
    };
  }, [endPointerInteraction]);

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

  const tabs: Tab[] = useMemo(() => buildTabs(entry, event), [entry, event]);

  // If a previously-selected tab disappears (e.g., entry reloaded with fewer
  // attempts), fall back to the first tab.
  useEffect(() => {
    if (!tabs.length) return;
    if (!tabs.some((t) => t.id === activeTab)) setActiveTab(tabs[0].id);
  }, [tabs, activeTab]);

  const downloadHref = api.eventLogRawURL(event.request_id);
  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || isInteractiveTarget(e.target)) return;
    e.preventDefault();
    interactionRef.current = {
      kind: "drag",
      startX: e.clientX,
      startY: e.clientY,
      startRect: rect,
    };
    beginPointerInteraction("move");
  };
  const startResize = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    interactionRef.current = {
      kind: "resize",
      startX: e.clientX,
      startY: e.clientY,
      startRect: rect,
    };
    beginPointerInteraction("nwse-resize");
  };
  const resetRect = () => setRect(initialModalRect());
  const resetRectFromHeader = (e: React.MouseEvent<HTMLElement>) => {
    if (!isInteractiveTarget(e.target)) resetRect();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60"
      onClick={onClose}
    >
      <div
        className="absolute bg-panel border border-border rounded-lg flex flex-col overflow-hidden shadow-2xl"
        role="dialog"
        aria-modal="true"
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between px-4 py-3 border-b border-border cursor-move select-none"
          onPointerDown={startDrag}
          onDoubleClick={resetRectFromHeader}
          title="Drag to move. Double-click to reset."
        >
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
                "text-xs border border-border rounded px-2 py-1 hover:text-ink cursor-pointer",
                (loading || missing) && "opacity-40 pointer-events-none",
              )}
              title="Download raw log file"
            >
              Download
            </a>
            <button
              onClick={onClose}
              className="text-muted hover:text-ink text-lg leading-none px-2 cursor-pointer"
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
        <button
          type="button"
          className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize text-muted hover:text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          aria-label="Resize dialog"
          onPointerDown={startResize}
          onDoubleClick={resetRect}
        >
          <span className="absolute bottom-1 right-1 h-3 w-3 border-b-2 border-r-2 border-current" />
        </button>
      </div>
    </div>
  );
}

const MODAL_PADDING = 16;
const MODAL_MIN_WIDTH = 480;
const MODAL_MIN_HEIGHT = 320;

function initialModalRect(): ModalRect {
  if (typeof window === "undefined") {
    return { x: MODAL_PADDING, y: MODAL_PADDING, width: 1024, height: 720 };
  }
  const maxWidth = Math.max(320, window.innerWidth - MODAL_PADDING * 2);
  const maxHeight = Math.max(240, window.innerHeight - MODAL_PADDING * 2);
  const width = Math.min(maxWidth, Math.max(Math.min(MODAL_MIN_WIDTH, maxWidth), 1024));
  const height = Math.min(maxHeight, Math.max(Math.min(MODAL_MIN_HEIGHT, maxHeight), Math.round(window.innerHeight * 0.9)));
  return {
    x: Math.round((window.innerWidth - width) / 2),
    y: Math.round((window.innerHeight - height) / 2),
    width,
    height,
  };
}

function applyModalMinSize(rect: ModalRect): ModalRect {
  const { minWidth, minHeight } = modalMinSize();
  return {
    ...rect,
    width: Math.max(rect.width, minWidth),
    height: Math.max(rect.height, minHeight),
  };
}

function modalMinSize(): { minWidth: number; minHeight: number } {
  if (typeof window === "undefined") {
    return { minWidth: MODAL_MIN_WIDTH, minHeight: MODAL_MIN_HEIGHT };
  }
  return {
    minWidth: Math.min(MODAL_MIN_WIDTH, Math.max(320, window.innerWidth - MODAL_PADDING * 2)),
    minHeight: Math.min(MODAL_MIN_HEIGHT, Math.max(240, window.innerHeight - MODAL_PADDING * 2)),
  };
}

function isInteractiveTarget(target: EventTarget): boolean {
  return target instanceof Element && !!target.closest("button, a, input, textarea, select, [data-no-drag]");
}

function buildTabs(entry: EventLogEntry | null, event: UsageEventRecord): Tab[] {
  if (!entry) return [];
  const tabs: Tab[] = [];

  tabs.push({
    id: "info",
    label: "Info",
    render: () => (
      <Panel>
        <div className="mb-3">
          <Label>Event</Label>
          <KVList map={eventRecordMap(event)} />
        </div>
        <div className="mb-3">
          <Label>File</Label>
          <div className="font-mono text-[11px] break-all">{entry.file}</div>
          <div
            className="mt-1 text-[11px] text-muted font-mono"
            title={entry.file_size_bytes != null ? `${entry.file_size_bytes.toLocaleString()} bytes` : undefined}
          >
            {formatBytes(entry.file_size_bytes)}
          </div>
        </div>
        <div className="mb-3">
          <Label>Request info</Label>
          <KVList map={entry.info} />
        </div>
      </Panel>
    ),
  });

  tabs.push({
    id: "request",
    label: "Request",
    badge: entry.request_body_truncated
      ? { text: "truncated", tone: "warn" }
      : undefined,
    render: () => (
      <Panel>
        <div className="mb-3">
          <Label>Headers</Label>
          <KVList map={entry.headers} />
        </div>
        <div>
          <Label>
            Body
            {entry.request_body_truncated && (
              <span className="ml-2 text-warn text-[10px] uppercase tracking-wider">
                truncated
              </span>
            )}
          </Label>
          <BodyView raw={entry.request_body} kind="request" />
        </div>
      </Panel>
    ),
  });

  const responses = entry.api_responses || [];
  if (responses.length > 0) {
    const last = responses[responses.length - 1];
    let badge: Tab["badge"];
    if (last.status) badge = { text: String(last.status), tone: statusTone(last.status) };
    else if (last.error) badge = { text: "ERR", tone: "danger" };
    tabs.push({
      id: "response",
      label: "Response",
      badge,
      render: () => (
        <Panel>
          <APIResponsesView attempts={responses} />
        </Panel>
      ),
    });
  }

  tabs.push({
    id: "final",
    label: "Final",
    badge: entry.response_body_truncated
      ? { text: "truncated", tone: "warn" }
      : undefined,
    render: () => (
      <Panel>
        <FinalChatView
          requestRaw={entry.request_body}
          responseRaw={finalResponseBody(entry)}
          responseTruncated={entry.response_body_truncated}
        />
      </Panel>
    ),
  });

  return tabs;
}

function eventRecordMap(event: UsageEventRecord): Record<string, string> {
  return {
    event_key: displayValue(event.event_key),
    timestamp: displayValue(formatTimestamp(event.timestamp)),
    provider: displayValue(event.provider),
    model: displayValue(event.model),
    api_group_key: displayValue(event.api_group_key),
    api_group_display: displayValue(event.api_group_display),
    source: displayValue(event.source),
    source_display: displayValue(event.source_display),
    auth_index: displayValue(event.auth_index),
    auth_type: displayValue(event.auth_type),
    endpoint: displayValue(event.endpoint),
    request_id: displayValue(event.request_id),
    latency_ms: displayValue(`${event.latency_ms} (${formatLatency(event.latency_ms)})`),
    input_tokens: formatNumber(event.input_tokens),
    cached_tokens: formatNumber(event.cached_tokens),
    output_tokens: formatNumber(event.output_tokens),
    reasoning_tokens: formatNumber(event.reasoning_tokens),
    total_tokens: formatNumber(event.total_tokens),
    failed: event.failed ? "true" : "false",
    cost: formatCost(event.cost),
  };
}

function displayValue(value: string | undefined | null): string {
  const v = (value || "").trim();
  return v || "—";
}

function APIResponsesView({ attempts }: { attempts: APIResponseAttempt[] }) {
  return (
    <div className="space-y-4">
      {attempts.map((attempt, index) => (
        <div key={attempt.index || index}>
          {attempts.length > 1 && (
            <div className="mb-2 flex items-center gap-2">
              <Label>Attempt {attempt.index || index + 1}</Label>
              {attempt.status ? (
                <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-mono", toneClass(statusTone(attempt.status)))}>
                  {attempt.status}
                </span>
              ) : attempt.error ? (
                <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-mono", toneClass("danger"))}>
                  ERR
                </span>
              ) : null}
            </div>
          )}
          <APIResponseAttemptView attempt={attempt} />
        </div>
      ))}
    </div>
  );
}

function APIResponseAttemptView({ attempt }: { attempt: APIResponseAttempt }) {
  const meta: Record<string, string> = {};
  if (attempt.timestamp) meta.Timestamp = attempt.timestamp;
  if (attempt.status) meta.Status = String(attempt.status);
  const hasHeaders = Object.keys(attempt.headers || {}).length > 0;
  const hasBody = (attempt.body || "").trim().length > 0;
  return (
    <>
      {Object.keys(meta).length > 0 && (
        <div className="mb-3">
          <Label>Attempt</Label>
          <KVList map={meta} />
        </div>
      )}
      {attempt.error && (
        <div className="mb-3">
          <Label>Transport error</Label>
          <pre className="bg-danger/10 border border-danger/30 text-danger rounded p-3 font-mono text-[11px] whitespace-pre-wrap break-words">
            {attempt.error}
          </pre>
        </div>
      )}
      {hasHeaders && (
        <div className="mb-3">
          <Label>Headers</Label>
          <KVList map={attempt.headers} />
        </div>
      )}
      {(hasBody || (!attempt.error && !hasHeaders)) && (
        <div>
          <Label>
            Body
            {attempt.body_truncated && (
              <span className="ml-2 text-warn text-[10px] uppercase tracking-wider">
                truncated
              </span>
            )}
          </Label>
          <BodyView raw={attempt.body} kind="response" />
        </div>
      )}
    </>
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

// BodyView toggles between a markdown projection of the protocol envelope and
// the raw bytes. For requests we extract conversation turns; for responses we
// concatenate SSE text deltas, falling back to JSON shape extraction for
// non-streaming bodies (e.g. 4xx errors).
function BodyView({ raw, kind }: { raw: string; kind: "request" | "response" }) {
  const projection = useMemo(() => {
    if (kind === "request") {
      const turns = extractRequestTurns(raw);
      const toolDeclarations = extractRequestToolDeclarations(raw);
      const turnCount = turns?.length ?? 0;
      const label = `${turnCount} turn${turnCount === 1 ? "" : "s"}${
        toolDeclarations ? " + tools" : ""
      }`;
      return turns || toolDeclarations
        ? { kind: "chat" as const, turns: turns ?? [], toolDeclarations, label }
        : null;
    }
    const stream = extractResponseStream(raw);
    if (stream.detected) {
      return {
        kind: "chat" as const,
        turns: [
          {
            role: "assistant",
            text: streamToMarkdown(stream),
            encrypted: stream.encrypted,
            hiddenType: stream.hiddenType,
            raw: responseRawValue(stream),
          },
	        ],
	        label: "stream",
	        toolDeclarations: null,
	      };
    }
    const json = extractResponseJSON(raw);
    if (json) {
      return {
        kind: "chat" as const,
        turns: [
          {
            role: "assistant",
            text: streamToMarkdown(json),
            encrypted: json.encrypted,
            hiddenType: json.hiddenType,
            raw: responseRawValue(json),
          },
	        ],
	        label: "json",
	        toolDeclarations: null,
	      };
    }
    return null;
  }, [raw, kind]);

  const [mode, setMode] = useState<"pretty" | "raw">(projection ? "pretty" : "raw");

  // Keep mode coherent if the underlying raw text changes (e.g. switching
  // tabs renders a different body and the projection result flips).
  useEffect(() => {
    if (!projection && mode === "pretty") setMode("raw");
  }, [projection, mode]);

  return (
    <div className="space-y-2">
      <div className="sticky top-0 z-10 -mx-3 -mt-3 flex items-center gap-1 border-b border-border bg-panel2/95 px-3 py-2 backdrop-blur">
        <ToggleButton
          active={mode === "pretty"}
          disabled={!projection}
          onClick={() => setMode("pretty")}
          title={projection ? `Rendered (${projection.label})` : "No structured content detected"}
        >
          Chat
        </ToggleButton>
        <ToggleButton active={mode === "raw"} onClick={() => setMode("raw")}>
          Raw
        </ToggleButton>
        {!projection && (
          <span className="text-[10px] text-muted ml-2">
            No structured content detected — showing raw bytes.
          </span>
        )}
      </div>
      {mode === "pretty" && projection ? (
        <StructuredChatView turns={projection.turns} toolDeclarations={projection.toolDeclarations} />
      ) : (
        <CodeBlock text={raw} />
      )}
    </div>
  );
}

function StructuredChatView({
  turns,
  toolDeclarations,
}: {
  turns: Turn[];
  toolDeclarations?: Turn | null;
}) {
  return (
    <div className="space-y-3">
      {turns.length ? <ChatView turns={turns} /> : null}
      {toolDeclarations ? (
        <div>
          <Label>Available tools</Label>
          <ChatView turns={[toolDeclarations]} />
        </div>
      ) : null}
    </div>
  );
}

function FinalChatView({
  requestRaw,
  responseRaw,
  responseTruncated,
}: {
  requestRaw: string;
  responseRaw: string;
  responseTruncated?: boolean;
}) {
  const turns = useMemo(() => finalChatTurns(requestRaw, responseRaw), [requestRaw, responseRaw]);
  const [mode, setMode] = useState<"pretty" | "raw">(turns.length ? "pretty" : "raw");

  useEffect(() => {
    if (!turns.length && mode === "pretty") setMode("raw");
  }, [turns.length, mode]);

  return (
    <div className="space-y-2">
      <div className="sticky top-0 z-10 -mx-3 -mt-3 flex items-center gap-1 border-b border-border bg-panel2/95 px-3 py-2 backdrop-blur">
        <ToggleButton
          active={mode === "pretty"}
          disabled={!turns.length}
          onClick={() => setMode("pretty")}
          title={
            turns.length
              ? `Rendered (${turns.length} turn${turns.length > 1 ? "s" : ""})`
              : "No structured content detected"
          }
        >
          Chat
        </ToggleButton>
        <ToggleButton active={mode === "raw"} onClick={() => setMode("raw")}>
          Raw
        </ToggleButton>
      </div>
      {mode === "pretty" && turns.length ? (
        <ChatView turns={turns} />
      ) : (
        <div className="space-y-3">
          <div>
            <Label>Request body</Label>
            <CodeBlock text={requestRaw} />
          </div>
          <div>
            <Label>
              Final response body
              {responseTruncated && (
                <span className="ml-2 text-warn text-[10px] uppercase tracking-wider">
                  truncated
                </span>
              )}
            </Label>
            <CodeBlock text={responseRaw} />
          </div>
        </div>
      )}
    </div>
  );
}

function finalChatTurns(requestRaw: string, responseRaw: string): Turn[] {
  const turns: Turn[] = [];
  const requestTurns = extractRequestTurns(requestRaw);
  if (requestTurns?.length) {
    turns.push(...requestTurns);
  } else if (requestRaw.trim()) {
    turns.push({ role: "user", text: fenceMarkdown(requestRaw.trim()), raw: requestRaw });
  }

  const responseTurn = responseToTurn(responseRaw);
  if (responseTurn) turns.push(responseTurn);
  return turns;
}

function responseToTurn(raw: string): Turn | null {
  if (!raw.trim()) return null;
  const stream = extractResponseStream(raw);
  if (stream.detected) {
    return {
      role: "assistant",
      text: streamToMarkdown(stream),
      encrypted: stream.encrypted,
      hiddenType: stream.hiddenType,
      raw: responseRawValue(stream),
    };
  }
  const json = extractResponseJSON(raw);
  if (json) {
    return {
      role: "assistant",
      text: streamToMarkdown(json),
      encrypted: json.encrypted,
      hiddenType: json.hiddenType,
      raw: responseRawValue(json),
    };
  }
  return { role: "assistant", text: fenceMarkdown(raw.trim()), raw };
}

function responseRawValue(extraction: StreamExtraction): unknown {
  return extraction.raw ?? mergedResponseRaw(extraction);
}

function mergedResponseRaw(extraction: StreamExtraction): Record<string, unknown> {
  const content = extraction.content.trim();
  const thinking = extraction.thinking.trim();
  const merged: Record<string, unknown> = {
    role: "assistant",
    content: content || "",
  };

  if (thinking) merged.thinking = thinking;
  if (extraction.hiddenType) merged.hidden_type = extraction.hiddenType;
  if (extraction.encrypted) merged.encrypted = true;
  if (extraction.errors.length) merged.errors = extraction.errors;

  return merged;
}

function finalResponseBody(entry: EventLogEntry): string {
  if (entry.response_body.trim()) return entry.response_body;
  const successful = [...(entry.api_responses || [])]
    .reverse()
    .find((r) => typeof r.status === "number" && r.status >= 200 && r.status < 300 && r.body);
  if (successful) return successful.body;
  for (let i = (entry.api_responses || []).length - 1; i >= 0; i -= 1) {
    const body = entry.api_responses[i].body;
    if (body) return body;
  }
  return "";
}

function fenceMarkdown(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

function ToggleButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        "text-[11px] px-2 py-0.5 rounded border",
        active
          ? "border-border bg-panel text-ink"
          : "border-transparent text-muted hover:text-ink",
        disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      {children}
    </button>
  );
}

function ChatView({ turns }: { turns: Turn[] }) {
  const [expandedTools, setExpandedTools] = useState<Set<number>>(() => new Set());
  const [expandedRaw, setExpandedRaw] = useState<Set<number>>(() => new Set());
  const toggleTool = (index: number) => {
    setExpandedTools((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const toggleRaw = (index: number) => {
    setExpandedRaw((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="bg-panel border border-border rounded p-3 chat-view">
      {turns.map((turn, index) => {
        const isTool = isToolTurn(turn);
        const collapsed = isTool && !expandedTools.has(index);
        const rawText = turnRawText(turn);
        const rawExpanded = rawText != null && expandedRaw.has(index);
        const hasActions = isTool || rawText != null;
        const bubbleClass = isTool ? "chat-bubble-tool" : chatBubbleClass(turn.role);
        const parts = rawExpanded || collapsed ? null : visualContentParts(turn);
        return (
          <div
            key={index}
            className={clsx(
              "chat-row",
              turn.role.toLowerCase() === "user" ? "chat-row-user" : "chat-row-left",
            )}
          >
            <div className={clsx("chat-bubble", bubbleClass, collapsed && "chat-bubble-collapsed")}>
              <div className="chat-meta">
                <span className={clsx("role-badge", isTool ? "role-badge-tool" : roleBadgeClass(turn.role))}>
                  {turn.role}
                </span>
                <span className="chat-turn">#{index + 1}</span>
                {hasActions && (
                  <div className="chat-actions">
                    {isTool && (
                      <button className="chat-toggle" onClick={() => toggleTool(index)}>
                        {collapsed ? "Expand" : "Collapse"}
                      </button>
                    )}
                    {rawText != null && (
                      <button
                        className={clsx("chat-toggle", rawExpanded && "chat-toggle-active")}
                        onClick={() => toggleRaw(index)}
                        aria-pressed={rawExpanded}
                        title="Show JSON"
                      >
                        {rawExpanded ? "Hide" : "JSON"}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {rawExpanded ? (
                <pre className="chat-raw-json">{rawText}</pre>
              ) : collapsed ? (
                <div className="chat-preview">{chatPreview(turn)}</div>
              ) : parts ? (
                <>
                  <StructuredContentParts parts={parts} fallbackText={turnText(turn)} />
                  {turn.attachments?.length ? (
                    <div className="chat-attachments">attachments: {turn.attachments.join("; ")}</div>
                  ) : null}
                </>
              ) : (
                <>
                  <MarkdownContent text={turnText(turn)} className="chat-body prose-md" />
                  {turn.attachments?.length ? (
                    <div className="chat-attachments">attachments: {turn.attachments.join("; ")}</div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MarkdownContent({ text, className }: { text: string; className: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={markdownUrlTransform}
        components={{ strong: MarkdownStrong }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function StructuredContentParts({
  parts,
  fallbackText,
}: {
  parts: Record<string, unknown>[];
  fallbackText: string;
}) {
  return (
    <div className="chat-parts">
      {parts.map((part, index) => (
        <StructuredContentPart key={index} part={part} index={index} />
      ))}
      {parts.length === 0 && <MarkdownContent text={fallbackText} className="chat-body prose-md" />}
    </div>
  );
}

function StructuredContentPart({ part, index }: { part: Record<string, unknown>; index: number }) {
  const type = stringRecordValue(part.type);
  if (type === "text" || type === "input_text" || type === "output_text") {
    const text = stringRecordValue(part.text);
    return text ? <MarkdownContent text={text} className="chat-part-text prose-md" /> : null;
  }
  if (type === "thinking" || type === "reasoning") {
    return <ThinkingPart part={part} type={type} />;
  }
  if (type === "redacted_thinking") {
    return (
      <div className="chat-hidden-part">
        <span className="part-type-badge">redacted_thinking</span>
        <span>Encrypted reasoning block</span>
      </div>
    );
  }
  if (type === "tool_use") {
    return <ToolUsePart part={part} index={index} />;
  }
  if (type === "tool_result") {
    return <ToolResultPart part={part} />;
  }
  return <GenericPart part={part} type={type || `part ${index + 1}`} />;
}

function ThinkingPart({ part, type }: { part: Record<string, unknown>; type: string }) {
  const text = stringRecordValue(part.thinking) || stringRecordValue(part.text);
  return (
    <div className="thinking-part">
      <div className="part-header">
        <span className="part-type-badge">{type}</span>
        {!text && <span className="part-muted">encrypted or redacted</span>}
      </div>
      {text ? <div className="thinking-text">{text}</div> : null}
    </div>
  );
}

function ToolUsePart({ part, index }: { part: Record<string, unknown>; index: number }) {
  const name = stringRecordValue(part.name) || `tool_${index + 1}`;
  const id = stringRecordValue(part.id) || stringRecordValue(part.tool_use_id) || stringRecordValue(part.call_id);
  const input = part.input ?? {};
  const questions = askUserQuestions(input);
  return (
    <div className="tool-use-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">tool_use</span>
          <span className="tool-name">{name}</span>
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      {questions ? (
        <AskUserQuestionView questions={questions} />
      ) : (
        <JsonValueBlock label="Input" value={input} />
      )}
    </div>
  );
}

function ToolResultPart({ part }: { part: Record<string, unknown> }) {
  const id = stringRecordValue(part.tool_use_id) || stringRecordValue(part.id) || stringRecordValue(part.call_id);
  return (
    <div className="tool-result-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">tool_result</span>
          {id && <span className="tool-id">{id}</span>}
        </div>
      </div>
      <ToolResultContent value={part.content} />
    </div>
  );
}

function ToolResultContent({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <pre className="tool-json-block">{value || "—"}</pre>;
  }
  if (Array.isArray(value)) {
    const objectParts = value.filter(isRecord);
    if (objectParts.length === value.length && objectParts.length > 0) {
      return <StructuredContentParts parts={objectParts} fallbackText="" />;
    }
  }
  return <JsonValueBlock label="Content" value={value ?? null} />;
}

interface VisualQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: VisualQuestionOption[];
}

interface VisualQuestionOption {
  label: string;
  description: string;
}

function AskUserQuestionView({ questions }: { questions: VisualQuestion[] }) {
  return (
    <div className="ask-user-questions">
      {questions.map((q, index) => (
        <div key={`${q.header}-${index}`} className="ask-question-card">
          <div className="ask-question-meta">
            {q.header && <span>{q.header}</span>}
            <span>{q.multiSelect ? "multi select" : "single select"}</span>
          </div>
          <div className="ask-question-text">{q.question || "Question"}</div>
          {q.options.length > 0 && (
            <div className="ask-options">
              {q.options.map((option, optionIndex) => (
                <div key={`${option.label}-${optionIndex}`} className="ask-option">
                  <div className="ask-option-label">{option.label || `Option ${optionIndex + 1}`}</div>
                  {option.description && (
                    <div className="ask-option-description">{option.description}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function GenericPart({ part, type }: { part: Record<string, unknown>; type: string }) {
  return (
    <div className="generic-part">
      <div className="part-header">
        <span className="part-type-badge">{type}</span>
      </div>
      <JsonValueBlock label="Payload" value={part} />
    </div>
  );
}

function JsonValueBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="tool-json-wrap">
      <div className="tool-json-label">{label}</div>
      <pre className="tool-json-block">{rawValueText(value)}</pre>
    </div>
  );
}

function visualContentParts(turn: Turn): Record<string, unknown>[] | null {
  const raw = isRecord(turn.raw) ? turn.raw : null;
  const content = raw?.content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter(isRecord);
  if (parts.length === 0) return null;
  return parts.some((part) => !isPlainTextPart(part)) ? parts : null;
}

function isPlainTextPart(part: Record<string, unknown>): boolean {
  const type = stringRecordValue(part.type);
  return (type === "text" || type === "input_text" || type === "output_text") && typeof part.text === "string";
}

function askUserQuestions(input: unknown): VisualQuestion[] | null {
  const obj = isRecord(input) ? input : null;
  const rawQuestions = obj?.questions;
  if (!Array.isArray(rawQuestions)) return null;
  const questions = rawQuestions.filter(isRecord).map((q): VisualQuestion => {
    const rawOptions = q.options;
    const options = Array.isArray(rawOptions)
      ? rawOptions.filter(isRecord).map((option) => ({
          label: stringRecordValue(option.label),
          description: stringRecordValue(option.description),
        }))
      : [];
    return {
      header: stringRecordValue(q.header),
      question: stringRecordValue(q.question),
      multiSelect: q.multiSelect === true || q.multi_select === true,
      options,
    };
  });
  return questions.length > 0 ? questions : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringRecordValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function turnRawText(turn: Turn): string | null {
  if (!Object.prototype.hasOwnProperty.call(turn, "raw")) return null;
  return rawValueText(turn.raw);
}

function rawValueText(value: unknown): string {
  if (typeof value === "string") {
    const stream = extractResponseStream(value);
    if (stream.detected) return rawValueText(responseRawValue(stream));
    const pretty = tryPrettyJson(value);
    return pretty || JSON.stringify(value);
  }
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function isToolTurn(turn: Turn): boolean {
  if (turn.role.toLowerCase() === "tool") return true;
  const text = turnText(turn).trimStart();
  if (startsWithCollapsibleBlock(text)) return true;
  const hiddenThinking = /^\*\*Thinking\*\*\s+_\((?:reasoning|thinking|redacted_thinking)\)_\s+(?:---\s+)?/s.exec(text);
  return hiddenThinking ? startsWithCollapsibleBlock(text.slice(hiddenThinking[0].length).trimStart()) : false;
}

function startsWithCollapsibleBlock(text: string): boolean {
  return startsWithToolBlock(text) || startsWithWebSearchCallBlock(text);
}

function startsWithToolBlock(text: string): boolean {
  return text.startsWith("**[tool_use ") || text.startsWith("**[tool_result");
}

function startsWithWebSearchCallBlock(text: string): boolean {
  return text.startsWith("**[web_search_call ");
}

function chatPreview(turn: Turn): string {
  const text = turnText(turn).replace(/[`*_#>\[\]()]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return "(empty)";
  return text.length > 160 ? text.slice(0, 160) + "..." : text;
}

function turnText(turn: Turn): string {
  if (turn.text) return turn.text;
  return turn.hiddenType ? `_(${turn.hiddenType})_` : "_(empty)_";
}

function chatBubbleClass(role: string): string {
  switch (role.toLowerCase()) {
    case "user":
      return "chat-bubble-user";
    case "assistant":
      return "chat-bubble-assistant";
    case "system":
    case "developer":
      return "chat-bubble-system";
    case "tool":
      return "chat-bubble-tool";
    default:
      return "chat-bubble-muted";
  }
}

function MarkdownStrong({ children }: { children?: React.ReactNode }) {
  const text = reactText(children);
  if (text.startsWith("@role:")) {
    const role = text.slice("@role:".length).trim() || "unknown";
    return <span className={clsx("role-badge", roleBadgeClass(role))}>{role}</span>;
  }
  return <strong>{children}</strong>;
}

function reactText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactText).join("");
  return "";
}

function roleBadgeClass(role: string): string {
  switch (role.toLowerCase()) {
    case "user":
      return "role-badge-user";
    case "assistant":
      return "role-badge-assistant";
    case "system":
    case "developer":
      return "role-badge-system";
    case "tool":
      return "role-badge-tool";
    default:
      return "role-badge-muted";
  }
}

function markdownUrlTransform(url: string, key: string): string {
  if (key === "src" && isSafeDataImageURL(url)) return url;
  return defaultUrlTransform(url);
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
