import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, HttpError } from "../api/client";
import type { APIResponseAttempt, EventLogEntry, EventLogProgress, UsageEventRecord } from "../api/types";
import { formatBytes, formatCost, formatLatency, formatNumber, formatTimestamp } from "../lib/utils";
import {
  displayableGeneratedImageURLFromPart,
  displayableImageURLFromPart,
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
  const [loadProgress, setLoadProgress] = useState<EventLogProgress | null>(null);
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
    const controller = new AbortController();
    setLoading(true);
    setErr(null);
    setMissing(false);
    setEntry(null);
    setLoadProgress(null);
    setActiveTab("info");
    api
      .eventLog(
        event.request_id,
        (progress) => {
          if (!cancelled) setLoadProgress(progress);
        },
        controller.signal,
      )
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
      controller.abort();
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

        {loading && <LoadingLogView requestId={event.request_id} progress={loadProgress} />}
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

function LoadingLogView({
  requestId,
  progress,
}: {
  requestId: string;
  progress: EventLogProgress | null;
}) {
  const total = progress?.totalBytes;
  const loaded = progress?.loadedBytes ?? 0;
  const percent = total && total > 0 ? Math.min(100, (loaded / total) * 100) : null;
  const rate = progress ? formatBytes(progress.bytesPerSecond) + "/s" : "—";
  const transferred = total
    ? `${formatBytes(loaded)} / ${formatBytes(total)}`
    : loaded > 0
      ? `${formatBytes(loaded)} downloaded`
      : "Waiting for response";

  return (
    <div className="flex-1 grid place-items-center px-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="font-medium text-ink">Loading log...</span>
          <span className="min-w-0 truncate font-mono text-[10px] text-muted" title={requestId}>
            {requestId}
          </span>
        </div>
        <div
          className="log-loading-track mt-3"
          role="progressbar"
          aria-label="Loading request log"
          aria-busy="true"
          aria-valuemin={percent == null ? undefined : 0}
          aria-valuemax={percent == null ? undefined : 100}
          aria-valuenow={percent == null ? undefined : Math.round(percent)}
        >
          {percent == null ? (
            <div className="log-loading-fill" />
          ) : (
            <div className="log-loading-fill-fixed" style={{ width: `${percent}%` }} />
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted">
          <span>{transferred}</span>
          <span className="font-mono">{rate}</span>
        </div>
        <div className="mt-1 text-[11px] text-muted">
          {percent == null ? "Total size is unavailable; showing live transfer." : `${percent.toFixed(1)}%`}
        </div>
      </div>
    </div>
  );
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
    alias: displayValue(event.alias),
    api_group_key: displayValue(event.api_group_key),
    api_group_display: displayValue(event.api_group_display),
    source: displayValue(event.source),
    source_display: displayValue(event.source_display),
    auth_index: displayValue(event.auth_index),
    auth_type: displayValue(event.auth_type),
    endpoint: displayValue(event.endpoint),
    request_id: displayValue(event.request_id),
    latency_ms: displayValue(`${event.latency_ms} (${formatLatency(event.latency_ms)})`),
    ttft_ms: displayValue(`${event.ttft_ms} (${formatLatency(event.ttft_ms)})`),
    input_tokens: formatNumber(event.input_tokens),
    cached_tokens: formatNumber(event.cached_tokens),
    cache_read_tokens: formatNumber(event.cache_read_tokens),
    cache_creation_tokens: formatNumber(event.cache_creation_tokens),
    output_tokens: formatNumber(event.output_tokens),
    reasoning_tokens: formatNumber(event.reasoning_tokens),
    total_tokens: formatNumber(event.total_tokens),
    failed: event.failed ? "true" : "false",
    fail_status_code: event.fail_status_code ? String(event.fail_status_code) : "—",
    fail_body: displayValue(event.fail_body),
    reasoning_effort: displayValue(event.reasoning_effort),
    service_tier: displayValue(event.service_tier),
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
    <div
      className="h-full bg-panel2 border border-border rounded p-3 overflow-y-auto text-xs"
      data-event-log-scroll
    >
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

const CodeBlock = memo(function CodeBlock({ text }: { text: string }) {
  const pretty = tryPrettyJson(text);
  return (
    <pre
      className="bg-panel border border-border rounded p-3 font-mono text-[11px] whitespace-pre-wrap break-words"
      data-final-search-block
    >
      {pretty || <span className="text-muted">—</span>}
    </pre>
  );
});

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
  const userTurnIndexes = useMemo(
    () => turns.flatMap((turn, index) => (isUserQuestionTurn(turn) ? [index] : [])),
    [turns],
  );
  const [mode, setMode] = useState<"pretty" | "raw">(turns.length ? "pretty" : "raw");
  const [selectedUserPosition, setSelectedUserPosition] = useState(() => userTurnIndexes.length - 1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchNeedle, setSearchNeedle] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchLimitReached, setSearchLimitReached] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const chatRef = useRef<HTMLDivElement>(null);
  const searchRootRef = useRef<HTMLDivElement>(null);
  const searchMatchesRef = useRef<FinalSearchMatch[]>([]);
  const activeSearchIndexRef = useRef(-1);
  const searchDebounceRef = useRef<number | null>(null);

  const invalidateSearch = useCallback(() => {
    activeSearchIndexRef.current = -1;
    searchMatchesRef.current = [];
    setActiveSearchIndex(-1);
    setSearchMatchCount(0);
    setSearchLimitReached(false);
    clearFinalSearchHighlights(searchRootRef.current || undefined);
  }, []);

  useEffect(() => {
    if (!turns.length && mode === "pretty") {
      invalidateSearch();
      setMode("raw");
    }
  }, [turns.length, mode, invalidateSearch]);

  useEffect(() => {
    setSelectedUserPosition(userTurnIndexes.length - 1);
  }, [userTurnIndexes]);

  const rebuildSearch = useCallback(() => {
    const root = searchRootRef.current;
    if (!root) return;
    const result = collectFinalSearchMatches(root, searchNeedle, MAX_FINAL_SEARCH_MATCHES);
    searchMatchesRef.current = result.matches;
    setSearchMatchCount(result.matches.length);
    setSearchLimitReached(result.limitReached);

    let nextIndex = activeSearchIndexRef.current;
    if (result.matches.length === 0) nextIndex = -1;
    else if (nextIndex >= result.matches.length) nextIndex = result.matches.length - 1;
    activeSearchIndexRef.current = nextIndex;
    setActiveSearchIndex(nextIndex);
    applyFinalSearchHighlights(root, result.matches, nextIndex);
  }, [searchNeedle, searchRevision]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(rebuildSearch);
    return () => window.cancelAnimationFrame(frame);
  }, [mode, rebuildSearch, turns]);

  useEffect(() => {
    const root = searchRootRef.current;
    if (!root) return;
    let frame = 0;
    const observer = new MutationObserver((mutations) => {
      if (!mutations.some(mutationAffectsFinalSearch)) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(rebuildSearch);
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [rebuildSearch]);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current != null) {
        window.clearTimeout(searchDebounceRef.current);
      }
      clearFinalSearchHighlights();
    };
  }, []);

  const jumpToUser = (position: number) => {
    if (!userTurnIndexes.length) return;
    const wrappedPosition = (position + userTurnIndexes.length) % userTurnIndexes.length;
    const turnIndex = userTurnIndexes[wrappedPosition];
    setSelectedUserPosition(wrappedPosition);
    chatRef.current
      ?.querySelector<HTMLElement>(`[data-chat-turn-index="${turnIndex}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
  };

  const selectedUserTurnIndex = userTurnIndexes[selectedUserPosition];
  const changeMode = (nextMode: "pretty" | "raw") => {
    if (nextMode === mode) return;
    invalidateSearch();
    if (searchDebounceRef.current != null) {
      window.clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    setSearchNeedle(searchQuery);
    setSearchRevision((revision) => revision + 1);
    setMode(nextMode);
  };
  const updateSearchQuery = (value: string) => {
    invalidateSearch();
    setSearchQuery(value);
    if (searchDebounceRef.current != null) {
      window.clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = window.setTimeout(() => {
      setSearchNeedle(value);
      setSearchRevision((revision) => revision + 1);
      searchDebounceRef.current = null;
    }, 120);
  };
  const jumpToSearch = (direction: -1 | 1) => {
    const matches = searchMatchesRef.current;
    if (!matches.length) return;
    const current = activeSearchIndexRef.current;
    const nextIndex = current < 0
      ? direction > 0 ? 0 : matches.length - 1
      : (current + direction + matches.length) % matches.length;
    activeSearchIndexRef.current = nextIndex;
    setActiveSearchIndex(nextIndex);
    if (searchRootRef.current) {
      applyFinalSearchActiveHighlight(searchRootRef.current, matches, nextIndex);
    }
    scrollToFinalSearchMatch(matches[nextIndex]);
  };
  const locateCurrentSearch = () => {
    const matches = searchMatchesRef.current;
    if (!matches.length) return;
    if (activeSearchIndexRef.current < 0) {
      jumpToSearch(1);
      return;
    }
    scrollToFinalSearchMatch(matches[activeSearchIndexRef.current]);
  };
  const clearSearch = () => {
    invalidateSearch();
    if (searchDebounceRef.current != null) {
      window.clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    setSearchQuery("");
    setSearchNeedle("");
    setSearchRevision((revision) => revision + 1);
  };
  const searchPosition = activeSearchIndex >= 0 ? activeSearchIndex + 1 : 0;
  const searchCountLabel = `${searchPosition}/${searchMatchCount}${searchLimitReached ? "+" : ""}`;

  return (
    <div className="space-y-2">
      <div className="sticky top-0 z-10 -mx-3 -mt-3 flex flex-wrap items-center gap-1 border-b border-border bg-panel2/95 px-3 py-2 backdrop-blur">
        <ToggleButton
          active={mode === "pretty"}
          disabled={!turns.length}
          onClick={() => changeMode("pretty")}
          title={
            turns.length
              ? `Rendered (${turns.length} turn${turns.length > 1 ? "s" : ""})`
              : "No structured content detected"
          }
        >
          Chat
        </ToggleButton>
        <ToggleButton active={mode === "raw"} onClick={() => changeMode("raw")}>
          Raw
        </ToggleButton>
        <div className="final-search-controls">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => updateSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                jumpToSearch(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape" && searchQuery) {
                e.preventDefault();
                e.stopPropagation();
                clearSearch();
              }
            }}
            className="final-search-input"
            aria-label="Search Final content"
            placeholder="Search Final"
          />
          {searchQuery && (
            <button
              type="button"
              className="final-search-button"
              onClick={clearSearch}
              aria-label="Clear Final search"
              title="Clear search"
            >
              ×
            </button>
          )}
          <button
            type="button"
            className="final-search-count"
            onClick={locateCurrentSearch}
            disabled={!searchMatchCount}
            aria-label={`Locate current search match (${searchCountLabel})`}
            title={searchLimitReached ? "Showing the first 5,000 matches" : "Locate current match"}
          >
            {searchCountLabel}
          </button>
          <button
            type="button"
            className="final-search-button"
            onClick={() => jumpToSearch(-1)}
            disabled={!searchMatchCount}
            aria-label="Previous search match"
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            type="button"
            className="final-search-button"
            onClick={() => jumpToSearch(1)}
            disabled={!searchMatchCount}
            aria-label="Next search match"
            title="Next match (Enter)"
          >
            ↓
          </button>
        </div>
        {mode === "pretty" && userTurnIndexes.length > 0 && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="chat-user-nav-button"
              onClick={() => jumpToUser(selectedUserPosition - 1)}
              aria-label="Previous user question"
              title="Previous user question"
            >
              ↑
            </button>
            <button
              type="button"
              className="chat-user-nav-current"
              onClick={() => jumpToUser(selectedUserPosition)}
              aria-label={`Jump to user question ${selectedUserPosition + 1} of ${userTurnIndexes.length}`}
              title={`Jump to user question ${selectedUserPosition + 1} of ${userTurnIndexes.length} (turn #${selectedUserTurnIndex + 1})`}
            >
              User {selectedUserPosition + 1}/{userTurnIndexes.length}
            </button>
            <button
              type="button"
              className="chat-user-nav-button"
              onClick={() => jumpToUser(selectedUserPosition + 1)}
              aria-label="Next user question"
              title="Next user question"
            >
              ↓
            </button>
          </div>
        )}
      </div>
      <div ref={searchRootRef}>
        {mode === "pretty" && turns.length ? (
          <ChatView
            turns={turns}
            rootRef={chatRef}
            locatedTurnIndex={selectedUserTurnIndex}
          />
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
    </div>
  );
}

const FINAL_SEARCH_MATCH_HIGHLIGHT = "final-search-match";
const FINAL_SEARCH_ACTIVE_HIGHLIGHT = "final-search-active";
const MAX_FINAL_SEARCH_MATCHES = 5000;

interface FinalSearchMatch {
  range: Range;
  block: HTMLElement;
}

interface FinalSearchResult {
  matches: FinalSearchMatch[];
  limitReached: boolean;
}

interface SearchTextSegment {
  node: Text;
  start: number;
  end: number;
}

function collectFinalSearchMatches(
  root: HTMLElement,
  rawQuery: string,
  limit: number,
): FinalSearchResult {
  const query = rawQuery.trim();
  if (!query) return { matches: [], limitReached: false };
  const expression = new RegExp(escapeRegExp(query), "giu");
  const matches: FinalSearchMatch[] = [];
  let limitReached = false;

  for (const block of root.querySelectorAll<HTMLElement>("[data-final-search-block]")) {
    const segments = finalSearchTextSegments(block);
    if (!segments.length) continue;
    const text = segments.map((segment) => segment.node.data).join("");
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      const start = match.index ?? -1;
      if (start < 0) continue;
      const range = finalSearchRange(segments, start, start + match[0].length);
      if (!range) continue;
      if (matches.length >= limit) {
        limitReached = true;
        return { matches, limitReached };
      }
      matches.push({ range, block });
    }
  }

  return { matches, limitReached };
}

function finalSearchTextSegments(block: HTMLElement): SearchTextSegment[] {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("[data-final-search-ignore], script, style")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const segments: SearchTextSegment[] = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const length = textNode.data.length;
    segments.push({ node: textNode, start: offset, end: offset + length });
    offset += length;
  }
  return segments;
}

function finalSearchRange(
  segments: SearchTextSegment[],
  start: number,
  end: number,
): Range | null {
  const startSegment = finalSearchSegmentAt(segments, start, false);
  const endSegment = finalSearchSegmentAt(segments, end, true);
  if (!startSegment || !endSegment) return null;
  const range = document.createRange();
  range.setStart(startSegment.node, start - startSegment.start);
  range.setEnd(endSegment.node, end - endSegment.start);
  return range;
}

function finalSearchSegmentAt(
  segments: SearchTextSegment[],
  offset: number,
  endBoundary: boolean,
): SearchTextSegment | null {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const segment = segments[mid];
    if (endBoundary ? offset <= segment.start : offset < segment.start) {
      high = mid - 1;
    } else if (endBoundary ? offset > segment.end : offset >= segment.end) {
      low = mid + 1;
    } else {
      return segment;
    }
  }
  return null;
}

function mutationAffectsFinalSearch(mutation: MutationRecord): boolean {
  const target = mutation.target.nodeType === Node.TEXT_NODE
    ? mutation.target.parentElement
    : mutation.target as Element;
  return !target?.closest("[data-final-search-ignore]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyFinalSearchHighlights(
  root: HTMLElement,
  matches: FinalSearchMatch[],
  activeIndex: number,
) {
  clearFinalSearchHighlights(root);
  if (typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined") {
    if (matches.length > 0) {
      const allMatches = new Highlight();
      for (const match of matches) allMatches.add(match.range);
      CSS.highlights.set(FINAL_SEARCH_MATCH_HIGHLIGHT, allMatches);
    }
  }
  applyFinalSearchActiveHighlight(root, matches, activeIndex);
}

function applyFinalSearchActiveHighlight(
  root: HTMLElement,
  matches: FinalSearchMatch[],
  activeIndex: number,
) {
  if (typeof CSS !== "undefined" && CSS.highlights) {
    CSS.highlights.delete(FINAL_SEARCH_ACTIVE_HIGHLIGHT);
  }
  root.querySelectorAll(".final-search-current-block").forEach((element) => {
    element.classList.remove("final-search-current-block");
  });
  const active = matches[activeIndex];
  if (active && typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined") {
    CSS.highlights.set(FINAL_SEARCH_ACTIVE_HIGHLIGHT, new Highlight(active.range));
  }
  matches[activeIndex]?.block.classList.add("final-search-current-block");
}

function clearFinalSearchHighlights(root?: HTMLElement) {
  if (typeof CSS !== "undefined" && CSS.highlights) {
    CSS.highlights.delete(FINAL_SEARCH_MATCH_HIGHLIGHT);
    CSS.highlights.delete(FINAL_SEARCH_ACTIVE_HIGHLIGHT);
  }
  root?.querySelectorAll(".final-search-current-block").forEach((element) => {
    element.classList.remove("final-search-current-block");
  });
}

function scrollToFinalSearchMatch(match: FinalSearchMatch) {
  const scroller = match.block.closest<HTMLElement>("[data-event-log-scroll]");
  const rect = match.range.getBoundingClientRect();
  if (scroller && (rect.width > 0 || rect.height > 0)) {
    const scrollerRect = scroller.getBoundingClientRect();
    const top =
      scroller.scrollTop +
      rect.top -
      scrollerRect.top -
      scroller.clientHeight / 2 +
      rect.height / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    return;
  }
  match.block.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
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

const ChatView = memo(function ChatView({
  turns,
  rootRef,
  locatedTurnIndex,
}: {
  turns: Turn[];
  rootRef?: React.Ref<HTMLDivElement>;
  locatedTurnIndex?: number;
}) {
  const [expandedTools, setExpandedTools] = useState<Set<number>>(() => new Set());
  const [expandedRaw, setExpandedRaw] = useState<Set<number>>(() => new Set());
  const [copiedTurn, setCopiedTurn] = useState<number | null>(null);
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
  const copyTurn = (index: number, text: string) => {
    void copyToClipboard(text).then((ok) => {
      if (ok) setCopiedTurn(index);
    });
  };

  useEffect(() => {
    if (copiedTurn == null) return;
    const timeout = window.setTimeout(() => setCopiedTurn(null), 1200);
    return () => window.clearTimeout(timeout);
  }, [copiedTurn]);

  return (
    <div ref={rootRef} className="bg-panel border border-border rounded p-3 chat-view">
      {turns.map((turn, index) => {
        const isTool = isToolTurn(turn);
        const isUserQuestion = isUserQuestionTurn(turn);
        const collapsed = isTool && !expandedTools.has(index);
        const rawText = turnRawText(turn);
        const rawExpanded = rawText != null && expandedRaw.has(index);
        const copyText = rawText ?? turnText(turn);
        const bubbleClass = isTool ? "chat-bubble-tool" : chatBubbleClass(turn.role);
        const parts = rawExpanded || collapsed ? null : visualContentParts(turn);
        return (
          <div
            key={index}
            data-chat-turn-index={index}
            className={clsx(
              "chat-row",
              turn.role.toLowerCase() === "user" ? "chat-row-user" : "chat-row-left",
              isUserQuestion && "chat-row-user-question",
              index === locatedTurnIndex && "chat-row-located",
            )}
          >
            <div
              className={clsx("chat-bubble", bubbleClass, collapsed && "chat-bubble-collapsed")}
              data-final-search-block
            >
              <div className="chat-meta" data-final-search-ignore>
                <span className={clsx("role-badge", isTool ? "role-badge-tool" : roleBadgeClass(turn.role))}>
                  {turn.role}
                </span>
                <span className="chat-turn">#{index + 1}</span>
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
                  <button
                    className={clsx("chat-toggle", copiedTurn === index && "chat-toggle-active")}
                    onClick={() => copyTurn(index, copyText)}
                    title={rawText != null ? "Copy JSON" : "Copy message text"}
                  >
                    {copiedTurn === index ? "Copied" : "Copy"}
                  </button>
                </div>
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
});

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
  if (type === "agent_message_meta") {
    return <AgentMessageMetaPart part={part} />;
  }
  if (type === "text" || type === "input_text" || type === "output_text") {
    return <TextPart part={part} />;
  }
  if (type === "encrypted_content") {
    return <EncryptedContentPart part={part} />;
  }
  if (type === "thinking" || type === "reasoning") {
    return type === "reasoning" ? <ReasoningPart part={part} /> : <ThinkingPart part={part} type={type} />;
  }
  if (type === "redacted_thinking") {
    return (
      <div className="chat-hidden-part">
        <span className="part-type-badge">redacted_thinking</span>
        <span>Encrypted reasoning block</span>
      </div>
    );
  }
  if (type === "tool_use" || type === "mcp_tool_use" || type === "server_tool_use") {
    return <ToolUsePart part={part} index={index} type={type} />;
  }
  if (type === "function_call" || type === "custom_tool_call") {
    return <FunctionCallPart part={part} type={type} />;
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return <FunctionCallOutputPart part={part} type={type} />;
  }
  if (type === "tool_result" || type === "mcp_tool_result" || type === "web_search_tool_result") {
    return <ToolResultPart part={part} type={type} />;
  }
  if (type === "input_file" || type === "input_audio" || type === "file" || type === "document") {
    return <FilePart part={part} type={type || "file"} />;
  }
  if (isImageVisualPart(type)) {
    return <ImagePart part={part} index={index} />;
  }
  if (type === "image_generation_call") {
    return <ImageGenerationPart part={part} />;
  }
  if (type === "web_search_call") {
    return <WebSearchCallPart part={part} />;
  }
  return <GenericPart part={part} type={type || `part ${index + 1}`} />;
}

function TextPart({ part }: { part: Record<string, unknown> }) {
  const text = stringRecordValue(part.text);
  const annotations = Array.isArray(part.annotations) ? part.annotations : [];
  return (
    <div>
      {text ? <MarkdownContent text={text} className="chat-part-text prose-md" /> : null}
      {annotations.length > 0 && (
        <div className="part-meta">
          <span className="part-chip">{annotations.length} annotation{annotations.length === 1 ? "" : "s"}</span>
        </div>
      )}
    </div>
  );
}

function AgentMessageMetaPart({ part }: { part: Record<string, unknown> }) {
  const author = stringRecordValue(part.author) || "agent";
  const recipient = stringRecordValue(part.recipient);
  return (
    <div className="agent-message-meta">
      <span className="part-type-badge">agent message</span>
      <span className="agent-message-route">
        {author}{recipient ? ` → ${recipient}` : ""}
      </span>
    </div>
  );
}

function EncryptedContentPart({ part }: { part: Record<string, unknown> }) {
  const length = stringRecordValue(part.encrypted_content ?? part.data).length;
  return (
    <div className="chat-hidden-part">
      <span className="part-type-badge">encrypted_content</span>
      <span>Encrypted content{length > 0 ? ` · ${formatNumber(length)} chars` : ""}</span>
    </div>
  );
}

function ImagePart({ part, index }: { part: Record<string, unknown>; index: number }) {
  const type = stringRecordValue(part.type) || "image";
  const url = displayableImageURLFromPart(part);
  const detail = stringRecordValue(part.detail);
  const fileID = stringRecordValue(part.file_id) || stringRecordValue(part.fileId);
  return (
    <div className="image-part">
      <div className="part-header">
        <span className="part-type-badge">{type}</span>
        {(detail || fileID) && <span className="part-muted">{detail || fileID}</span>}
      </div>
      {url ? (
        <img className="chat-image" src={url} alt={`image ${index + 1}`} loading="lazy" />
      ) : (
        <JsonValueBlock label="Image" value={part} />
      )}
    </div>
  );
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

function ReasoningPart({ part }: { part: Record<string, unknown> }) {
  const text = reasoningText(part);
  const encrypted = !!stringRecordValue(part.encrypted_content) || part.encrypted === true;
  return (
    <div className="thinking-part">
      <div className="part-header">
        <div className="tool-use-title">
          <span className="part-type-badge">reasoning</span>
          {stringRecordValue(part.status) && <span className="part-chip">{stringRecordValue(part.status)}</span>}
        </div>
        {stringRecordValue(part.id) && <span className="tool-id">{stringRecordValue(part.id)}</span>}
      </div>
      {text ? <div className="thinking-text">{text}</div> : null}
      {!text && encrypted ? (
        <div className="chat-hidden-part">
          <span>Encrypted reasoning block</span>
        </div>
      ) : null}
      {!text && !encrypted ? <JsonValueBlock label="Payload" value={part} /> : null}
    </div>
  );
}

function ToolUsePart({ part, index, type }: { part: Record<string, unknown>; index: number; type: string }) {
  const name = stringRecordValue(part.name) || `tool_${index + 1}`;
  const id = stringRecordValue(part.id) || stringRecordValue(part.tool_use_id) || stringRecordValue(part.call_id);
  const serverName = stringRecordValue(part.server_name);
  const input = part.input ?? {};
  const questions = askUserQuestions(input);
  return (
    <div className="tool-use-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          <span className="tool-name">{name}</span>
          {serverName && <span className="part-chip">{serverName}</span>}
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

function FunctionCallPart({ part, type }: { part: Record<string, unknown>; type: string }) {
  const name = qualifiedPartName(part, "function");
  const id = stringRecordValue(part.call_id) || stringRecordValue(part.id);
  const input = type === "custom_tool_call" ? part.input : part.arguments;
  return (
    <div className="tool-use-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          <span className="tool-name">{name}</span>
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      <JsonValueBlock label={type === "custom_tool_call" ? "Input" : "Arguments"} value={input ?? {}} />
    </div>
  );
}

function FunctionCallOutputPart({ part, type }: { part: Record<string, unknown>; type: string }) {
  const id = stringRecordValue(part.call_id) || stringRecordValue(part.id);
  return (
    <div className="tool-result-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      <ToolResultContent value={part.output ?? part.content ?? null} />
    </div>
  );
}

function ToolResultPart({ part, type }: { part: Record<string, unknown>; type: string }) {
  const id = stringRecordValue(part.tool_use_id) || stringRecordValue(part.id) || stringRecordValue(part.call_id);
  const serverName = stringRecordValue(part.server_name);
  return (
    <div className="tool-result-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          {part.is_error === true && <span className="part-chip part-chip-danger">error</span>}
          {serverName && <span className="part-chip">{serverName}</span>}
        </div>
        {id && <span className="tool-id">{id}</span>}
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

function FilePart({ part, type }: { part: Record<string, unknown>; type: string }) {
  const title =
    stringRecordValue(part.filename) ||
    stringRecordValue(part.name) ||
    stringRecordValue(part.title) ||
    stringRecordValue(part.file_id) ||
    stringRecordValue(part.fileId) ||
    stringRecordValue(part.file_url) ||
    "file";
  const source = isRecord(part.source) ? part.source : null;
  const sourceType = stringRecordValue(source?.type);
  const url = filePartURL(part);
  return (
    <div className="generic-part">
      <div className="part-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          <span className="tool-name">{title}</span>
        </div>
        {stringRecordValue(part.media_type ?? part.mime_type) && (
          <span className="part-muted">{stringRecordValue(part.media_type ?? part.mime_type)}</span>
        )}
      </div>
      <div className="part-meta">
        {stringRecordValue(part.file_id ?? part.fileId) && <span className="part-chip">{stringRecordValue(part.file_id ?? part.fileId)}</span>}
        {sourceType && <span className="part-chip">source: {sourceType}</span>}
        {Array.isArray(part.citations) && <span className="part-chip">{part.citations.length} citations</span>}
        {inlineDataLength(part) > 0 && <span className="part-chip">{formatNumber(inlineDataLength(part))} inline chars</span>}
        {url && (
          <a className="part-chip hover:text-ink" href={url} target="_blank" rel="noreferrer">
            Open
          </a>
        )}
      </div>
      <JsonValueBlock label="Details" value={filePartSummary(part)} />
    </div>
  );
}

function ImageGenerationPart({ part }: { part: Record<string, unknown> }) {
  const url = displayableGeneratedImageURLFromPart(part);
  return (
    <div className="image-part">
      <div className="part-header">
        <div className="tool-use-title">
          <span className="part-type-badge">image_generation_call</span>
          {stringRecordValue(part.status) && <span className="part-chip">{stringRecordValue(part.status)}</span>}
        </div>
        {stringRecordValue(part.id) && <span className="tool-id">{stringRecordValue(part.id)}</span>}
      </div>
      <div className="part-meta">
        {["action", "size", "quality", "background", "output_format"].map((key) =>
          stringRecordValue(part[key]) ? <span key={key} className="part-chip">{key}: {stringRecordValue(part[key])}</span> : null,
        )}
      </div>
      {url ? <img className="chat-image" src={url} alt="generated image" loading="lazy" /> : null}
      {stringRecordValue(part.revised_prompt) && (
        <div className="tool-json-wrap">
          <div className="tool-json-label">Revised prompt</div>
          <div className="tool-json-block">{stringRecordValue(part.revised_prompt)}</div>
        </div>
      )}
      {!url && <JsonValueBlock label="Payload" value={part} />}
    </div>
  );
}

function WebSearchCallPart({ part }: { part: Record<string, unknown> }) {
  const action = isRecord(part.action) ? part.action : null;
  const actionType = stringRecordValue(action?.type) || stringRecordValue(part.status) || "web_search";
  const sources = Array.isArray(action?.sources) ? action.sources.length : 0;
  return (
    <div className="generic-part">
      <div className="part-header">
        <div className="tool-use-title">
          <span className="part-type-badge">web_search_call</span>
          <span className="tool-name">{actionType}</span>
        </div>
        {stringRecordValue(part.id) && <span className="tool-id">{stringRecordValue(part.id)}</span>}
      </div>
      <div className="part-meta">
        {stringRecordValue(part.status) && <span className="part-chip">{stringRecordValue(part.status)}</span>}
        {stringRecordValue(action?.query) && <span className="part-chip">query</span>}
        {stringRecordValue(action?.url) && <span className="part-chip">url</span>}
        {sources > 0 && <span className="part-chip">{sources} sources</span>}
      </div>
      {action ? <JsonValueBlock label="Action" value={action} /> : <JsonValueBlock label="Payload" value={part} />}
    </div>
  );
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
  const rawType = stringRecordValue(raw?.type);
  if (raw && isStandaloneVisualPart(rawType)) return [raw];

  const content = raw?.content;
  const output = raw?.output;
  const parts = Array.isArray(content)
    ? content.filter(isRecord)
    : Array.isArray(output)
      ? output.flatMap(responsesOutputVisualParts)
      : [];
  if (rawType === "agent_message") {
    return [
      {
        type: "agent_message_meta",
        author: raw?.author,
        recipient: raw?.recipient,
      },
      ...parts,
    ];
  }
  if (parts.length === 0) return null;
  return parts.some((part) => !isPlainTextPart(part)) ? parts : null;
}

function responsesOutputVisualParts(item: unknown): Record<string, unknown>[] {
  if (!isRecord(item)) return [];
  const type = stringRecordValue(item.type);
  if (type === "message" && Array.isArray(item.content)) {
    return item.content.filter(isRecord);
  }
  return isStandaloneVisualPart(type) ? [item] : [];
}

function isStandaloneVisualPart(type: string): boolean {
  return (
    type === "function_call" ||
    type === "custom_tool_call" ||
    type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "image_generation_call" ||
    type === "web_search_call" ||
    type === "reasoning"
  );
}

function isPlainTextPart(part: Record<string, unknown>): boolean {
  const type = stringRecordValue(part.type);
  return (type === "text" || type === "input_text" || type === "output_text") && typeof part.text === "string";
}

function isImageVisualPart(type: string): boolean {
  return type === "image" || type === "input_image" || type === "image_url";
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

function reasoningText(part: Record<string, unknown>): string {
  const direct = stringRecordValue(part.text) || stringRecordValue(part.thinking);
  if (direct) return direct;
  const summary = Array.isArray(part.summary)
    ? part.summary
        .map((item) => (isRecord(item) ? stringRecordValue(item.text) : ""))
        .filter(Boolean)
        .join("\n")
    : "";
  if (summary) return summary;
  if (Array.isArray(part.content)) {
    return part.content
      .map((item) => {
        if (!isRecord(item)) return "";
        return stringRecordValue(item.text) || stringRecordValue(item.thinking);
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function filePartSummary(part: Record<string, unknown>): Record<string, unknown> {
  const source = isRecord(part.source) ? part.source : null;
  const summary: Record<string, unknown> = {};
  for (const key of [
    "type",
    "filename",
    "name",
    "title",
    "media_type",
    "mime_type",
    "file_id",
    "fileId",
    "file_url",
    "format",
  ]) {
    if (part[key] != null) summary[key] = part[key];
  }
  if (source) {
    summary.source = summarizeInlinePayload(source);
  }
  const dataKeys = ["file_data", "data"];
  for (const key of dataKeys) {
    const data = stringRecordValue(part[key]);
    if (data) summary[key] = isSafeAssetURL(data) ? data : `${data.length.toLocaleString()} chars`;
  }
  if (Array.isArray(part.citations)) summary.citations = `${part.citations.length} item${part.citations.length === 1 ? "" : "s"}`;
  return summary;
}

function summarizeInlinePayload(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if ((key === "data" || key === "file_data") && typeof raw === "string") {
      out[key] = isSafeAssetURL(raw) ? raw : `${raw.length.toLocaleString()} chars`;
    } else {
      out[key] = raw;
    }
  }
  return out;
}

function inlineDataLength(part: Record<string, unknown>): number {
  const own = inlineDataValueLength(part.file_data) || inlineDataValueLength(part.data);
  if (own) return own;
  const source = isRecord(part.source) ? part.source : null;
  return source ? inlineDataValueLength(source.data) || inlineDataValueLength(source.file_data) : 0;
}

function inlineDataValueLength(value: unknown): number {
  const text = stringRecordValue(value);
  return text && !isSafeAssetURL(text) ? text.length : 0;
}

function filePartURL(part: Record<string, unknown>): string {
  const source = isRecord(part.source) ? part.source : null;
  for (const value of [part.file_url, part.url, source?.url, part.file_data, part.data, source?.file_data, source?.data]) {
    const candidate = stringRecordValue(value).trim();
    if (isSafeAssetURL(candidate)) return candidate;
  }
  return "";
}

function isSafeAssetURL(value: string): boolean {
  return /^https?:\/\//i.test(value) || (value.startsWith("/") && !value.startsWith("//"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringRecordValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function qualifiedPartName(part: Record<string, unknown>, fallback: string): string {
  const name = stringRecordValue(part.name) || fallback;
  const namespace = stringRecordValue(part.namespace);
  if (!namespace || !name || name.startsWith(namespace + ".")) return name;
  return `${namespace}.${name}`;
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

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall back to execCommand */
    }
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function isToolTurn(turn: Turn): boolean {
  if (turn.role.toLowerCase() === "tool") return true;
  const text = turnText(turn).trimStart();
  if (startsWithCollapsibleBlock(text)) return true;
  const hiddenThinking = /^\*\*Thinking\*\*\s+_\((?:reasoning|thinking|redacted_thinking)\)_\s+(?:---\s+)?/s.exec(text);
  return hiddenThinking ? startsWithCollapsibleBlock(text.slice(hiddenThinking[0].length).trimStart()) : false;
}

function isUserQuestionTurn(turn: Turn): boolean {
  return turn.role.toLowerCase() === "user" && !isToolTurn(turn);
}

function startsWithCollapsibleBlock(text: string): boolean {
  return startsWithToolBlock(text) || startsWithWebSearchCallBlock(text);
}

function startsWithToolBlock(text: string): boolean {
  return (
    text.startsWith("**[tool_use ") ||
    text.startsWith("**[tool_result") ||
    text.startsWith("**[function_call ") ||
    text.startsWith("**[custom_tool_call ")
  );
}

function startsWithWebSearchCallBlock(text: string): boolean {
  return text.startsWith("**[web_search_call ");
}

function chatPreview(turn: Turn): string {
  const text = turnText(turn).replace(/[`*#>\[\]()]/g, "").replace(/\s+/g, " ").trim();
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
    case "agent":
      return "chat-bubble-agent";
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
    case "agent":
      return "role-badge-agent";
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
