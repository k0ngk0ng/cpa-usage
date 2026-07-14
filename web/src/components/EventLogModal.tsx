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
    executor_type: displayValue(event.executor_type),
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
    request_service_tier: displayValue(event.request_service_tier),
    response_service_tier: displayValue(event.response_service_tier),
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
  const [selectedAssetPosition, setSelectedAssetPosition] = useState(-1);
  const [assetCount, setAssetCount] = useState(0);
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
  const assetElementsRef = useRef<HTMLElement[]>([]);
  const selectedAssetPositionRef = useRef(-1);
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

  const rebuildAssetIndex = useCallback(() => {
    const assets = collectChatAssets(chatRef.current);
    assetElementsRef.current = assets;
    let nextPosition = selectedAssetPositionRef.current;
    if (!assets.length) nextPosition = -1;
    else if (nextPosition < 0 || nextPosition >= assets.length) nextPosition = assets.length - 1;
    selectedAssetPositionRef.current = nextPosition;
    setSelectedAssetPosition(nextPosition);
    setAssetCount(assets.length);
    applyChatAssetLocation(assets, nextPosition);
  }, []);

  useEffect(() => {
    selectedAssetPositionRef.current = -1;
    setSelectedAssetPosition(-1);
    const frame = window.requestAnimationFrame(rebuildAssetIndex);
    return () => window.cancelAnimationFrame(frame);
  }, [turns, rebuildAssetIndex]);

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
    const root = searchRootRef.current;
    if (!root) return;
    let frame = window.requestAnimationFrame(rebuildAssetIndex);
    const observer = new MutationObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(rebuildAssetIndex);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      applyChatAssetLocation(assetElementsRef.current, -1);
      assetElementsRef.current = [];
    };
  }, [rebuildAssetIndex]);

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

  const jumpToAsset = (position: number) => {
    const assets = collectChatAssets(chatRef.current);
    if (!assets.length) return;
    const wrappedPosition = (position + assets.length) % assets.length;
    assetElementsRef.current = assets;
    selectedAssetPositionRef.current = wrappedPosition;
    setSelectedAssetPosition(wrappedPosition);
    setAssetCount(assets.length);
    applyChatAssetLocation(assets, wrappedPosition);
    assets[wrappedPosition].scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
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
  const assetPosition = selectedAssetPosition >= 0 ? selectedAssetPosition + 1 : assetCount;

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
        {mode === "pretty" && (userTurnIndexes.length > 0 || assetCount > 0) && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {userTurnIndexes.length > 0 && (
              <div className="flex items-center gap-1">
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
            {assetCount > 0 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="chat-user-nav-button"
                  onClick={() => jumpToAsset(selectedAssetPosition - 1)}
                  aria-label="Previous asset"
                  title="Previous asset"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="chat-asset-nav-current"
                  onClick={() => jumpToAsset(selectedAssetPosition)}
                  aria-label={`Jump to asset ${assetPosition} of ${assetCount}`}
                  title={`Jump to asset ${assetPosition} of ${assetCount}`}
                >
                  Asset {assetPosition}/{assetCount}
                </button>
                <button
                  type="button"
                  className="chat-user-nav-button"
                  onClick={() => jumpToAsset(selectedAssetPosition + 1)}
                  aria-label="Next asset"
                  title="Next asset"
                >
                  ↓
                </button>
              </div>
            )}
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
const CHAT_ASSET_SELECTOR = "[data-chat-asset]";
const CHAT_ASSET_LOCATED_CLASS = "chat-asset-located";

function collectChatAssets(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>(CHAT_ASSET_SELECTOR)) : [];
}

function applyChatAssetLocation(assets: HTMLElement[], activeIndex: number) {
  assets.forEach((asset, index) => {
    asset.classList.toggle(CHAT_ASSET_LOCATED_CLASS, index === activeIndex);
  });
}

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
  const toolNamesByCallID = useMemo(() => collectToolCallNames(turns), [turns]);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(
    () => new Set(
      turns.flatMap((turn, index) =>
        isToolTurn(turn) && turnContainsVisualAsset(turn) ? [index] : [],
      ),
    ),
  );
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
        const roleLabel = isTool ? toolTurnRoleLabel(turn) : turn.role;
        return (
          <div
            key={index}
            data-chat-turn-index={index}
            className={clsx(
              "chat-row",
              isRightAlignedTurn(turn) ? "chat-row-user" : "chat-row-left",
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
                  {roleLabel}
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
                <div className="chat-preview">{chatPreview(turn, toolNamesByCallID)}</div>
              ) : parts ? (
                <>
                  <StructuredContentParts
                    parts={parts}
                    fallbackText={turnText(turn)}
                    toolNamesByCallID={toolNamesByCallID}
                  />
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
  toolNamesByCallID,
}: {
  parts: Record<string, unknown>[];
  fallbackText: string;
  toolNamesByCallID?: Map<string, string>;
}) {
  return (
    <div className="chat-parts">
      {parts.map((part, index) => (
        <StructuredContentPart
          key={index}
          part={part}
          index={index}
          toolNamesByCallID={toolNamesByCallID}
        />
      ))}
      {parts.length === 0 && <MarkdownContent text={fallbackText} className="chat-body prose-md" />}
    </div>
  );
}

function StructuredContentPart({
  part,
  index,
  toolNamesByCallID,
}: {
  part: Record<string, unknown>;
  index: number;
  toolNamesByCallID?: Map<string, string>;
}) {
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
  if (type === "tool_search_call") {
    return <ToolSearchCallPart part={part} />;
  }
  if (type === "tool_search_output") {
    return <ToolSearchOutputPart part={part} />;
  }
  if (type === "tool_declarations") {
    return <ToolDeclarationsPart part={part} />;
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return (
      <FunctionCallOutputPart
        part={part}
        type={type}
        toolName={resolvedToolName(part, toolNamesByCallID)}
      />
    );
  }
  if (type === "tool_result" || type === "mcp_tool_result" || type === "web_search_tool_result") {
    return (
      <ToolResultPart
        part={part}
        type={type}
        toolName={resolvedToolName(part, toolNamesByCallID)}
      />
    );
  }
  if (isToolCallPartType(type)) {
    return <ProtocolToolCallPart part={part} type={type} />;
  }
  if (isToolResultPartType(type)) {
    return (
      <ProtocolToolResultPart
        part={part}
        type={type}
        toolName={resolvedToolName(part, toolNamesByCallID)}
      />
    );
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
    <div
      className="image-part"
      data-chat-asset={url ? "image" : undefined}
    >
      <div className="part-header">
        <span className="part-type-badge">{type}</span>
        {(detail || fileID) && <span className="part-muted">{detail || fileID}</span>}
      </div>
      {url ? (
        <InlineImageAsset url={url} alt={`image ${index + 1}`} />
      ) : (
        <FriendlyRecord value={part} omit={["type"]} />
      )}
    </div>
  );
}

function InlineImageAsset({ url, alt }: { url: string; alt: string }) {
  const [visible, setVisible] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setVisible(false);
    setLoadFailed(false);
  }, [url]);

  const toggleVisible = () => {
    if (!visible) setLoadFailed(false);
    setVisible((current) => !current);
  };

  return (
    <div className="asset-view">
      <div className="asset-actions">
        <button
          type="button"
          className="asset-action"
          onClick={toggleVisible}
          aria-pressed={visible}
        >
          {visible ? "Hide" : "Show"}
        </button>
        <a className="asset-action" href={assetDownloadURL(url)} download>
          Download
        </a>
      </div>
      {visible && (
        <>
          <img
            className={clsx("chat-image", loadFailed && "hidden")}
            src={url}
            alt={alt}
            onLoad={() => setLoadFailed(false)}
            onError={() => setLoadFailed(true)}
          />
          {loadFailed && <div className="asset-error">Unable to load this image.</div>}
        </>
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
      {!text && !encrypted ? <FriendlyRecord value={part} omit={["type"]} /> : null}
    </div>
  );
}

function ToolUsePart({ part, index, type }: { part: Record<string, unknown>; index: number; type: string }) {
  const name = stringRecordValue(part.name) || `tool_${index + 1}`;
  const id = stringRecordValue(part.id) || stringRecordValue(part.tool_use_id) || stringRecordValue(part.call_id);
  const serverName = stringRecordValue(part.server_name);
  const input = part.input ?? {};
  return (
    <div className="tool-use-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          <span className="tool-name">{name}</span>
          {serverName && <span className="part-chip">{serverName}</span>}
          {stringRecordValue(part.status) && <span className="part-chip">{stringRecordValue(part.status)}</span>}
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      <ToolInputView toolName={name} value={input} />
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
          {stringRecordValue(part.status) && <span className="part-chip">{stringRecordValue(part.status)}</span>}
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      <ToolInputView toolName={name} value={input ?? {}} />
    </div>
  );
}

function ToolSearchCallPart({ part }: { part: Record<string, unknown> }) {
  const id = stringRecordValue(part.call_id) || stringRecordValue(part.id);
  return (
    <div className="tool-use-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">tool search</span>
          <span className="tool-name">Discover tools</span>
          {stringRecordValue(part.execution) && <span className="part-chip">{stringRecordValue(part.execution)}</span>}
          {stringRecordValue(part.status) && <span className="part-chip">{stringRecordValue(part.status)}</span>}
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      <ToolInputView toolName="tool_search" value={part.arguments ?? {}} />
    </div>
  );
}

function ToolSearchOutputPart({ part }: { part: Record<string, unknown> }) {
  const id = stringRecordValue(part.call_id) || stringRecordValue(part.id);
  const summary = summarizeToolDefinitions(Array.isArray(part.tools) ? part.tools : []);
  return (
    <div className="tool-result-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">tool search result</span>
          <span className="tool-name">
            Loaded {summary.toolCount} tool{summary.toolCount === 1 ? "" : "s"}
          </span>
          {summary.namespaceCount > 0 && (
            <span className="part-chip">
              {summary.namespaceCount} namespace{summary.namespaceCount === 1 ? "" : "s"}
            </span>
          )}
          {stringRecordValue(part.execution) && <span className="part-chip">{stringRecordValue(part.execution)}</span>}
          {stringRecordValue(part.status) && <span className="part-chip">{stringRecordValue(part.status)}</span>}
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      <ToolDefinitionGroups summary={summary} emptyText="No tools were loaded." />
    </div>
  );
}

function ToolDeclarationsPart({ part }: { part: Record<string, unknown> }) {
  const summary = summarizeToolDefinitions(Array.isArray(part.tools) ? part.tools : []);
  return (
    <div className="tool-use-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">available tools</span>
          <span className="tool-name">
            {summary.toolCount} tool{summary.toolCount === 1 ? "" : "s"}
          </span>
          {summary.namespaceCount > 0 && (
            <span className="part-chip">
              {summary.namespaceCount} namespace{summary.namespaceCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>
      <ToolDefinitionGroups summary={summary} emptyText="No tools declared." />
    </div>
  );
}

function ToolDefinitionGroups({
  summary,
  emptyText,
}: {
  summary: ToolDefinitionSummary;
  emptyText: string;
}) {
  if (summary.groups.length === 0) return <div className="tool-empty">{emptyText}</div>;
  return (
    <div className="tool-search-groups">
      {summary.groups.map((group, index) => (
        <div className="tool-search-group" key={`${group.name}-${index}`}>
          <div className="tool-search-group-title">
            <span>{group.name}</span>
            <span>{group.tools.length} tool{group.tools.length === 1 ? "" : "s"}</span>
          </div>
          {group.description && <div className="tool-search-description">{group.description}</div>}
          <div className="tool-search-tools">
            {group.tools.map((tool, toolIndex) => (
              <div className="tool-search-tool" key={`${tool.name}-${toolIndex}`}>
                <span className="tool-search-tool-name">{tool.name}</span>
                {tool.description && <span className="tool-search-tool-description">{tool.description}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FunctionCallOutputPart({
  part,
  type,
  toolName,
}: {
  part: Record<string, unknown>;
  type: string;
  toolName?: string;
}) {
  const id = stringRecordValue(part.call_id) || stringRecordValue(part.id);
  return (
    <div className="tool-result-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          {toolName && <span className="tool-name">{toolName}</span>}
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      <ToolResultContent value={part.output ?? part.content ?? null} toolName={toolName} />
    </div>
  );
}

function ToolResultPart({
  part,
  type,
  toolName,
}: {
  part: Record<string, unknown>;
  type: string;
  toolName?: string;
}) {
  const id = stringRecordValue(part.tool_use_id) || stringRecordValue(part.id) || stringRecordValue(part.call_id);
  const serverName = stringRecordValue(part.server_name);
  return (
    <div className="tool-result-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          {toolName && <span className="tool-name">{toolName}</span>}
          {part.is_error === true && <span className="part-chip part-chip-danger">error</span>}
          {serverName && <span className="part-chip">{serverName}</span>}
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      <ToolResultContent value={part.content} toolName={toolName} />
    </div>
  );
}

function ProtocolToolCallPart({ part, type }: { part: Record<string, unknown>; type: string }) {
  const name = qualifiedPartName(part, friendlyTypeLabel(type.replace(/_call$/, "")));
  const id = stringRecordValue(part.call_id) || stringRecordValue(part.id);
  const input = toolCallPayload(part);
  return (
    <div className="tool-use-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          <span className="tool-name">{name}</span>
          {stringRecordValue(part.status) && <span className="part-chip">{stringRecordValue(part.status)}</span>}
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      <ToolInputView toolName={name} value={input} />
    </div>
  );
}

function ProtocolToolResultPart({
  part,
  type,
  toolName,
}: {
  part: Record<string, unknown>;
  type: string;
  toolName?: string;
}) {
  const id = stringRecordValue(part.call_id) || stringRecordValue(part.tool_use_id) || stringRecordValue(part.id);
  return (
    <div className="tool-result-card">
      <div className="tool-use-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          {toolName && <span className="tool-name">{toolName}</span>}
          {part.is_error === true && <span className="part-chip part-chip-danger">error</span>}
          {stringRecordValue(part.status) && <span className="part-chip">{stringRecordValue(part.status)}</span>}
        </div>
        {id && <span className="tool-id">{id}</span>}
      </div>
      <ToolResultContent value={toolResultPayload(part)} toolName={toolName} />
    </div>
  );
}

function ToolResultContent({ value, toolName }: { value: unknown; toolName?: string }) {
  if (typeof value === "string") {
    const command = parseCommandResult(value);
    if (command && isCommandToolName(toolName)) {
      return <CommandResultView result={command} />;
    }
    const parsed = parseEmbeddedJSON(value);
    if (parsed !== value) return <FriendlyValue value={parsed} />;
    return <pre className="tool-text-block">{value || "—"}</pre>;
  }
  if (Array.isArray(value)) {
    const objectParts = value.filter(isRecord);
    if (objectParts.length === value.length && objectParts.length > 0) {
      return <StructuredContentParts parts={objectParts} fallbackText="" />;
    }
  }
  return <FriendlyValue value={value ?? null} />;
}

function ToolInputView({ toolName, value }: { toolName: string; value: unknown }) {
  const parsed = parseEmbeddedJSON(value);
  const questions = askUserQuestions(parsed);
  if (questions) return <AskUserQuestionView questions={questions} />;

  const plan = planInput(parsed);
  if (plan && bareToolName(toolName) === "update_plan") {
    return <PlanInputView explanation={plan.explanation} steps={plan.steps} />;
  }

  const command = toolCommandInput(toolName, parsed);
  if (command) {
    return (
      <div className="tool-command-view">
        <div className="tool-command-heading">
          <span>{command.label}</span>
          {command.meta.length > 0 && (
            <div className="part-meta">
              {command.meta.map((item) => <span className="part-chip" key={item}>{item}</span>)}
            </div>
          )}
        </div>
        <pre className={clsx("tool-command-block", command.language && `language-${command.language}`)}>
          {command.text || "(empty)"}
        </pre>
        {Object.keys(command.remaining).length > 0 && (
          <FriendlyRecord value={command.remaining} />
        )}
      </div>
    );
  }

  return <FriendlyValue value={parsed} />;
}

interface PlanStepView {
  step: string;
  status: string;
}

function PlanInputView({ explanation, steps }: { explanation: string; steps: PlanStepView[] }) {
  return (
    <div className="tool-plan-view">
      {explanation && <div className="tool-plan-explanation">{explanation}</div>}
      <div className="tool-plan-steps">
        {steps.map((step, index) => (
          <div className="tool-plan-step" key={`${step.step}-${index}`}>
            <span className={clsx("tool-plan-status", `tool-plan-status-${normalizeStatus(step.status)}`)}>
              {step.status || "pending"}
            </span>
            <span>{step.step || `Step ${index + 1}`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ParsedCommandResult {
  status: "completed" | "running";
  exitCode?: number;
  wallTime?: string;
  originalTokens?: number;
  chunkID?: string;
  cellID?: string;
  truncated: boolean;
  output: string;
}

function CommandResultView({ result }: { result: ParsedCommandResult }) {
  return (
    <div className="tool-result-view">
      <div className="part-meta">
        <span className={clsx("part-chip", result.exitCode != null && result.exitCode !== 0 && "part-chip-danger")}>
          {result.status === "running"
            ? "running"
            : result.exitCode == null
              ? "completed"
              : `exit ${result.exitCode}`}
        </span>
        {result.wallTime && <span className="part-chip">{result.wallTime}</span>}
        {result.originalTokens != null && <span className="part-chip">{formatNumber(result.originalTokens)} tokens</span>}
        {result.truncated && <span className="part-chip part-chip-danger">truncated</span>}
        {result.chunkID && <span className="part-chip">chunk {result.chunkID}</span>}
        {result.cellID && <span className="part-chip">cell {result.cellID}</span>}
      </div>
      <pre className="tool-text-block">{result.output || "(no output)"}</pre>
    </div>
  );
}

function FriendlyValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const parsed = depth === 0 ? parseEmbeddedJSON(value) : value;
  if (parsed == null) return <span className="tool-empty">—</span>;
  if (typeof parsed === "boolean") {
    return <span className={clsx("part-chip", parsed ? "part-chip-positive" : "")}>{String(parsed)}</span>;
  }
  if (typeof parsed === "number" || typeof parsed === "bigint") {
    return <span className="tool-inline-value">{String(parsed)}</span>;
  }
  if (typeof parsed === "string") {
    if (looksLikePatch(parsed)) return <pre className="tool-command-block language-patch">{parsed}</pre>;
    if (parsed.includes("\n") || parsed.length > 120) return <pre className="tool-text-block">{parsed}</pre>;
    return <span className="tool-inline-value">{parsed || "(empty)"}</span>;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return <span className="tool-empty">(empty list)</span>;
    if (depth >= 4) return <span className="part-chip">{parsed.length} items</span>;
    const primitives = parsed.every((item) => item == null || ["string", "number", "boolean"].includes(typeof item));
    if (primitives) {
      return (
        <div className="tool-value-chips">
          {parsed.map((item, index) => <span className="part-chip" key={index}>{String(item ?? "null")}</span>)}
        </div>
      );
    }
    return (
      <div className="tool-value-list">
        {parsed.map((item, index) => (
          <div className="tool-value-list-item" key={index}>
            <span className="tool-value-index">{index + 1}</span>
            <FriendlyValue value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  if (isRecord(parsed)) {
    if (depth >= 4) return <span className="part-chip">{Object.keys(parsed).length} fields</span>;
    return <FriendlyRecord value={parsed} depth={depth} />;
  }
  return <span className="tool-inline-value">{String(parsed)}</span>;
}

function FriendlyRecord({
  value,
  depth = 0,
  omit = [],
}: {
  value: Record<string, unknown>;
  depth?: number;
  omit?: string[];
}) {
  const omitted = new Set(omit);
  const entries = Object.entries(value)
    .filter(([key, field]) => !omitted.has(key) && field !== undefined)
    .sort(([a], [b]) => friendlyFieldRank(a) - friendlyFieldRank(b));
  if (entries.length === 0) return <span className="tool-empty">(no fields)</span>;
  return (
    <dl className="tool-field-grid">
      {entries.map(([key, field]) => (
        <div className="tool-field-row" key={key}>
          <dt className="tool-field-label">{friendlyTypeLabel(key)}</dt>
          <dd className="tool-field-value"><FriendlyValue value={field} depth={depth + 1} /></dd>
        </div>
      ))}
    </dl>
  );
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
  const mediaType = filePartMediaType(part, url);
  const canPreview = mediaType === "application/pdf";
  const [previewVisible, setPreviewVisible] = useState(false);

  useEffect(() => {
    setPreviewVisible(false);
  }, [url]);

  return (
    <div
      className="generic-part"
      data-chat-asset={url ? "file" : undefined}
    >
      <div className="part-header">
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          <span className="tool-name">{title}</span>
        </div>
        {mediaType && (
          <span className="part-muted">{mediaType}</span>
        )}
      </div>
      <div className="part-meta">
        {stringRecordValue(part.file_id ?? part.fileId) && <span className="part-chip">{stringRecordValue(part.file_id ?? part.fileId)}</span>}
        {sourceType && <span className="part-chip">source: {sourceType}</span>}
        {Array.isArray(part.citations) && <span className="part-chip">{part.citations.length} citations</span>}
        {inlineDataLength(part) > 0 && <span className="part-chip">{formatNumber(inlineDataLength(part))} inline chars</span>}
      </div>
      {url && (
        <div className="asset-actions">
          {canPreview && (
            <button
              type="button"
              className="asset-action"
              onClick={() => setPreviewVisible((current) => !current)}
              aria-pressed={previewVisible}
            >
              {previewVisible ? "Hide" : "Preview"}
            </button>
          )}
          <a className="asset-action" href={url} target="_blank" rel="noreferrer">
            Open
          </a>
          <a className="asset-action" href={assetDownloadURL(url)} download>
            Download
          </a>
        </div>
      )}
      {previewVisible && url && (
        <iframe className="chat-document-preview" src={url} title={`${title} preview`} loading="lazy" />
      )}
      <FriendlyRecord value={filePartSummary(part)} />
    </div>
  );
}

function ImageGenerationPart({ part }: { part: Record<string, unknown> }) {
  const url = displayableGeneratedImageURLFromPart(part);
  return (
    <div
      className="image-part"
      data-chat-asset={url ? "image" : undefined}
    >
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
      {url ? <InlineImageAsset url={url} alt="generated image" /> : null}
      {stringRecordValue(part.revised_prompt) && (
        <div className="tool-json-wrap">
          <div className="tool-json-label">Revised prompt</div>
          <div className="tool-text-block">{stringRecordValue(part.revised_prompt)}</div>
        </div>
      )}
      {!url && <FriendlyRecord value={part} omit={["type", "id", "status"]} />}
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
      {action
        ? <FriendlyRecord value={action} omit={["type"]} />
        : <FriendlyRecord value={part} omit={["type", "id", "status"]} />}
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
        <div className="tool-use-title">
          <span className="part-type-badge">{type}</span>
          {stringRecordValue(part.name) && <span className="tool-name">{stringRecordValue(part.name)}</span>}
          {stringRecordValue(part.status) && <span className="part-chip">{stringRecordValue(part.status)}</span>}
        </div>
        {stringRecordValue(part.id ?? part.call_id) && (
          <span className="tool-id">{stringRecordValue(part.id ?? part.call_id)}</span>
        )}
      </div>
      <FriendlyRecord value={part} omit={["type", "name", "id", "call_id", "status"]} />
    </div>
  );
}

function visualContentParts(turn: Turn): Record<string, unknown>[] | null {
  if (Array.isArray(turn.raw) && turn.role.toLowerCase() === "tool") {
    return [{ type: "tool_declarations", tools: turn.raw }];
  }
  const raw = isRecord(turn.raw) ? turn.raw : null;
  const rawType = stringRecordValue(raw?.type);
  if (raw && rawType && rawType !== "message" && rawType !== "agent_message") return [raw];

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
  return type ? [item] : [];
}

function isPlainTextPart(part: Record<string, unknown>): boolean {
  const type = stringRecordValue(part.type);
  return (type === "text" || type === "input_text" || type === "output_text") && typeof part.text === "string";
}

function isImageVisualPart(type: string): boolean {
  return type === "image" || type === "input_image" || type === "image_url";
}

function isFileVisualPart(type: string): boolean {
  return type === "input_file" || type === "input_audio" || type === "file" || type === "document";
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
    if (data) summary[key] = isSafeAssetURL(data) ? "available on demand" : `${data.length.toLocaleString()} chars`;
  }
  if (Array.isArray(part.citations)) summary.citations = `${part.citations.length} item${part.citations.length === 1 ? "" : "s"}`;
  return summary;
}

function summarizeInlinePayload(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if ((key === "data" || key === "file_data") && typeof raw === "string") {
      out[key] = isSafeAssetURL(raw) ? "available on demand" : `${raw.length.toLocaleString()} chars`;
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

function filePartMediaType(part: Record<string, unknown>, url: string): string {
  const source = isRecord(part.source) ? part.source : null;
  const direct = stringRecordValue(
    part.media_type ?? part.mime_type ?? part.mimeType ?? source?.media_type ?? source?.mime_type ?? source?.mimeType,
  ).trim();
  if (direct) return direct.toLowerCase();
  if (!url) return "";
  try {
    return new URL(url, "http://cpa.local").searchParams.get("mime")?.toLowerCase() || "";
  } catch {
    return "";
  }
}

function assetDownloadURL(url: string): string {
  if (!url || url.startsWith("data:")) return url;
  try {
    const parsed = new URL(url, "http://cpa.local");
    if (!parsed.pathname.endsWith("/log/asset")) return url;
    parsed.searchParams.set("download", "1");
    if (/^https?:\/\//i.test(url)) return parsed.toString();
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function isSafeAssetURL(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  try {
    return new URL(value, "http://cpa.local").pathname.endsWith("/log/asset");
  } catch {
    return false;
  }
}

interface ToolDefinitionView {
  name: string;
  description: string;
}

interface ToolDefinitionGroupView {
  name: string;
  description: string;
  tools: ToolDefinitionView[];
}

interface ToolDefinitionSummary {
  namespaceCount: number;
  toolCount: number;
  groups: ToolDefinitionGroupView[];
}

function summarizeToolDefinitions(rawTools: unknown[]): ToolDefinitionSummary {
  let namespaceCount = 0;
  let toolCount = 0;
  const groups: ToolDefinitionGroupView[] = [];
  const ungrouped: ToolDefinitionView[] = [];

  rawTools.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const type = stringRecordValue(raw.type);
    const name = toolDefinitionName(raw, index);
    if (type === "namespace") {
      namespaceCount += 1;
      const tools = Array.isArray(raw.tools)
        ? raw.tools.filter(isRecord).map((tool, toolIndex) => ({
            name: toolDefinitionName(tool, toolIndex),
            description: compactDescription(tool.description),
          }))
        : [];
      toolCount += tools.length;
      groups.push({
        name,
        description: compactDescription(raw.description),
        tools,
      });
      return;
    }
    toolCount += 1;
    ungrouped.push({ name, description: compactDescription(raw.description) });
  });

  if (ungrouped.length > 0) {
    groups.push({ name: "Tools", description: "", tools: ungrouped });
  }
  return { namespaceCount, toolCount, groups };
}

function toolDefinitionName(tool: Record<string, unknown>, index: number): string {
  return (
    stringRecordValue(tool.name) ||
    stringRecordValue(tool.server_label) ||
    stringRecordValue(tool.type) ||
    `tool ${index + 1}`
  );
}

function compactDescription(value: unknown, max = 220): string {
  const text = stringRecordValue(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function parseEmbeddedJSON(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function bareToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return normalized.split(/[.:/]/).filter(Boolean).pop() || normalized;
}

function isCommandToolName(name?: string): boolean {
  if (!name) return false;
  const bare = bareToolName(name);
  return /^(?:exec_command|execute_command|run_command|shell|bash|terminal|write_stdin|js)$/.test(bare);
}

interface ToolCommandView {
  label: string;
  language: string;
  text: string;
  meta: string[];
  remaining: Record<string, unknown>;
}

function toolCommandInput(toolName: string, value: unknown): ToolCommandView | null {
  const bare = bareToolName(toolName);
  if (typeof value === "string") {
    if (looksLikePatch(value) || bare === "apply_patch") {
      return {
        label: "Patch",
        language: "patch",
        text: value,
        meta: patchMeta(value),
        remaining: {},
      };
    }
    if (isCommandToolName(toolName)) {
      return { label: bare === "js" ? "JavaScript" : "Command", language: bare === "js" ? "javascript" : "shell", text: value, meta: [], remaining: {} };
    }
    return null;
  }
  if (!isRecord(value)) return null;

  let key = "";
  let label = "Command";
  let language = "shell";
  if (typeof value.patch === "string") {
    key = "patch";
    label = "Patch";
    language = "patch";
  } else if (typeof value.cmd === "string") {
    key = "cmd";
  } else if (typeof value.command === "string" || Array.isArray(value.command)) {
    key = "command";
  } else if (Array.isArray(value.commands)) {
    key = "commands";
  } else if (typeof value.script === "string") {
    key = "script";
  } else if (typeof value.code === "string" && (bare === "js" || bare.includes("repl"))) {
    key = "code";
    label = "JavaScript";
    language = "javascript";
  } else if (typeof value.chars === "string" && bare === "write_stdin" && value.chars) {
    key = "chars";
    label = "Input";
    language = "";
  }
  if (!key) return null;

  const raw = value[key];
  const text = Array.isArray(raw) ? raw.map((item) => String(item)).join("\n") : String(raw ?? "");
  const remaining = { ...value };
  delete remaining[key];
  const meta: string[] = language === "patch" ? patchMeta(text) : [];
  for (const metaKey of [
    "workdir",
    "cwd",
    "timeout_ms",
    "yield_time_ms",
    "max_output_tokens",
    "session_id",
    "cell_id",
    "tty",
    "sandbox_permissions",
  ]) {
    if (remaining[metaKey] == null || remaining[metaKey] === "") continue;
    meta.push(toolMetaLabel(metaKey, remaining[metaKey]));
    delete remaining[metaKey];
  }
  return { label, language, text, meta, remaining };
}

function toolMetaLabel(key: string, value: unknown): string {
  if ((key === "timeout_ms" || key === "yield_time_ms") && typeof value === "number") {
    return `${friendlyTypeLabel(key)}: ${formatMilliseconds(value)}`;
  }
  if (key === "max_output_tokens" && typeof value === "number") {
    return `output: ${formatNumber(value)} tokens`;
  }
  if (key === "session_id") return `session: ${String(value)}`;
  if (key === "cell_id") return `cell: ${String(value)}`;
  return `${friendlyTypeLabel(key)}: ${String(value)}`;
}

function formatMilliseconds(value: number): string {
  if (value < 1000) return `${value} ms`;
  const seconds = value / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

function looksLikePatch(value: string): boolean {
  return value.trimStart().startsWith("*** Begin Patch") || /^diff --git /m.test(value);
}

function patchMeta(value: string): string[] {
  const files = value.match(/^\*\*\* (?:Add|Update|Delete) File:/gm)?.length
    ?? value.match(/^diff --git /gm)?.length
    ?? 0;
  const additions = value.split(/\r?\n/).filter((line) => /^\+(?!\+\+)/.test(line)).length;
  const deletions = value.split(/\r?\n/).filter((line) => /^-(?!--)/.test(line)).length;
  return [
    files ? `${files} file${files === 1 ? "" : "s"}` : "",
    additions ? `+${additions}` : "",
    deletions ? `-${deletions}` : "",
  ].filter(Boolean);
}

function planInput(value: unknown): { explanation: string; steps: PlanStepView[] } | null {
  if (!isRecord(value) || !Array.isArray(value.plan)) return null;
  const steps = value.plan.filter(isRecord).map((step) => ({
    step: stringRecordValue(step.step),
    status: stringRecordValue(step.status) || "pending",
  }));
  return {
    explanation: stringRecordValue(value.explanation),
    steps,
  };
}

function normalizeStatus(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "pending";
}

function parseCommandResult(value: string): ParsedCommandResult | null {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const outputMarker = lines.findIndex((line) => line.trim() === "Output:");
  const header = outputMarker >= 0 ? lines.slice(0, outputMarker) : lines;
  let recognized = false;
  let status: ParsedCommandResult["status"] = "completed";
  let exitCode: number | undefined;
  let wallTime: string | undefined;
  let originalTokens: number | undefined;
  let chunkID: string | undefined;
  let cellID: string | undefined;
  let lastMetaIndex = -1;

  for (const [index, line] of header.entries()) {
    let match = /^Chunk ID:\s*(.+)$/.exec(line);
    if (match) { chunkID = match[1].trim(); recognized = true; lastMetaIndex = index; continue; }
    match = /^Wall time:\s*(.+)$/.exec(line);
    if (match) { wallTime = match[1].trim(); recognized = true; lastMetaIndex = index; continue; }
    match = /^Process exited with code\s+(-?\d+)$/.exec(line);
    if (match) { exitCode = Number(match[1]); recognized = true; lastMetaIndex = index; continue; }
    match = /^Original token count:\s*(\d+)$/.exec(line);
    if (match) { originalTokens = Number(match[1]); recognized = true; lastMetaIndex = index; continue; }
    match = /^Script running with cell ID\s+(.+)$/.exec(line);
    if (match) { cellID = match[1].trim(); status = "running"; recognized = true; lastMetaIndex = index; continue; }
    if (line.trim() === "Script completed") { recognized = true; lastMetaIndex = index; }
  }
  if (!recognized) return null;

  const truncated = /Warning: truncated output|Total output lines:/i.test(value);
  const outputLines = outputMarker >= 0
    ? lines.slice(outputMarker + 1)
    : lines.slice(lastMetaIndex + 1);
  while (
    outputLines.length > 0 &&
    (!outputLines[0].trim() || /^Warning: truncated output|^Total output lines:/i.test(outputLines[0]))
  ) {
    outputLines.shift();
  }
  const output = outputLines.join("\n").trimEnd();
  return {
    status,
    exitCode,
    wallTime,
    originalTokens,
    chunkID,
    cellID,
    truncated,
    output,
  };
}

function toolCallPayload(part: Record<string, unknown>): unknown {
  if (part.input !== undefined) return part.input;
  if (part.arguments !== undefined) return part.arguments;
  if (part.action !== undefined) return part.action;
  const payload = { ...part };
  for (const key of ["type", "id", "call_id", "status", "name", "namespace", "server_name"]) delete payload[key];
  return payload;
}

function toolResultPayload(part: Record<string, unknown>): unknown {
  if (part.output !== undefined) return part.output;
  if (part.result !== undefined) return part.result;
  if (part.content !== undefined) return part.content;
  const payload = { ...part };
  for (const key of ["type", "id", "call_id", "tool_use_id", "status", "name", "namespace", "is_error"]) delete payload[key];
  return payload;
}

function isToolCallPartType(type: string): boolean {
  return (
    type === "tool_use" ||
    type === "mcp_tool_use" ||
    type === "server_tool_use" ||
    type.endsWith("_tool_use") ||
    type.endsWith("_call")
  );
}

function isToolResultPartType(type: string): boolean {
  return (
    type === "tool_result" ||
    type.endsWith("_tool_result") ||
    type.endsWith("_call_output")
  );
}

function friendlyTypeLabel(value: string): string {
  const known: Record<string, string> = {
    workdir: "workdir",
    cwd: "cwd",
    timeout_ms: "timeout",
    yield_time_ms: "yield",
    max_output_tokens: "output limit",
    sandbox_permissions: "sandbox",
    call_id: "call id",
    tool_use_id: "tool use id",
  };
  if (known[value]) return known[value];
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\bms\b/gi, "ms")
    .trim();
}

function friendlyFieldRank(key: string): number {
  const order = [
    "query", "goal", "path", "paths", "url", "method", "command", "cmd", "code", "input",
    "workdir", "cwd", "status", "execution", "limit", "timeout_ms", "yield_time_ms",
  ];
  const index = order.indexOf(key);
  return index >= 0 ? index : order.length;
}

function collectToolCallNames(turns: Turn[]): Map<string, string> {
  const names = new Map<string, string>();
  const visit = (value: unknown, depth = 0) => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    const type = stringRecordValue(value.type);
    if (isToolCallPartType(type)) {
      const id = stringRecordValue(value.call_id) || stringRecordValue(value.id) || stringRecordValue(value.tool_use_id);
      if (id) names.set(id, toolPartName(value, type));
    }
    visit(value.content, depth + 1);
    visit(value.output, depth + 1);
  };
  turns.forEach((turn) => visit(turn.raw));
  return names;
}

function toolPartName(part: Record<string, unknown>, type: string): string {
  if (type === "tool_search_call") return "tool search";
  const fallback = friendlyTypeLabel(type.replace(/(?:_call|_tool_use)$/, "")) || "tool";
  return qualifiedPartName(part, fallback);
}

function resolvedToolName(part: Record<string, unknown>, names?: Map<string, string>): string | undefined {
  const direct = stringRecordValue(part.name);
  if (direct) return qualifiedPartName(part, direct);
  const id = stringRecordValue(part.call_id) || stringRecordValue(part.tool_use_id) || stringRecordValue(part.id);
  return id ? names?.get(id) : undefined;
}

function toolPartsFromTurn(turn: Turn): Record<string, unknown>[] {
  if (Array.isArray(turn.raw) && turn.role.toLowerCase() === "tool") {
    return [{ type: "tool_declarations", tools: turn.raw }];
  }
  const raw = isRecord(turn.raw) ? turn.raw : null;
  if (!raw) return [];
  const type = stringRecordValue(raw.type);
  if (isToolCallPartType(type) || isToolResultPartType(type) || type === "tool_search_output" || type === "tool_declarations") {
    return [raw];
  }
  const candidates = [raw.content, raw.output];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const parts = candidate.filter(isRecord).filter((part) => {
      const partType = stringRecordValue(part.type);
      return isToolCallPartType(partType) || isToolResultPartType(partType) || partType === "tool_search_output";
    });
    if (parts.length > 0) return parts;
  }
  return [];
}

function toolTurnRoleLabel(turn: Turn): string {
  const first = toolPartsFromTurn(turn)[0];
  const type = stringRecordValue(first?.type);
  if (type === "tool_declarations") return "tools";
  if (type === "tool_search_output" || isToolResultPartType(type)) return "tool result";
  if (type) return "tool call";
  return "tool";
}

function isRightAlignedTurn(turn: Turn): boolean {
  if (turn.role.toLowerCase() === "user") return true;
  if (turn.role.toLowerCase() === "assistant") return false;
  const type = stringRecordValue(toolPartsFromTurn(turn)[0]?.type);
  return type === "tool_search_output" || isToolResultPartType(type);
}

function toolTurnPreview(turn: Turn, names: Map<string, string>): string {
  const parts = toolPartsFromTurn(turn);
  const part = parts[0];
  if (!part) return "";
  const type = stringRecordValue(part.type);
  let preview = "";
  if (type === "tool_declarations") {
    const summary = summarizeToolDefinitions(Array.isArray(part.tools) ? part.tools : []);
    preview = `Available tools · ${summary.toolCount} tools${summary.namespaceCount ? ` · ${summary.namespaceCount} namespaces` : ""}`;
  } else if (type === "tool_search_call") {
    const args = parseEmbeddedJSON(part.arguments);
    const record = isRecord(args) ? args : null;
    const query = stringRecordValue(record?.query ?? record?.goal);
    const paths = Array.isArray(record?.paths) ? record.paths.map(String).join(", ") : "";
    const target = query || paths || summarizeInput(args);
    const limit = typeof record?.limit === "number" ? ` · limit ${record.limit}` : "";
    preview = `Search tools${target ? ` · ${target}` : ""}${limit}`;
  } else if (type === "tool_search_output") {
    const summary = summarizeToolDefinitions(Array.isArray(part.tools) ? part.tools : []);
    preview = `Loaded ${summary.toolCount} tools${summary.namespaceCount ? ` from ${summary.namespaceCount} namespaces` : ""}`;
  } else if (isToolCallPartType(type)) {
    const name = toolPartName(part, type);
    const input = parseEmbeddedJSON(toolCallPayload(part));
    const plan = planInput(input);
    const command = toolCommandInput(name, input);
    if (plan && bareToolName(name) === "update_plan") {
      const active = plan.steps.find((step) => step.status === "in_progress");
      preview = `Update plan · ${plan.steps.length} steps${active ? ` · ${active.step}` : ""}`;
    } else if (command) {
      const firstLine = command.text.split(/\r?\n/).find((line) => line.trim())?.trim() || "(empty)";
      const meta = command.language === "patch" ? command.meta.join(" · ") : "";
      preview = command.language === "patch"
        ? `${name}${meta ? ` · ${meta}` : " · patch"}`
        : `${name} · ${truncatePreview(firstLine, 120)}`;
    } else {
      const summary = summarizeInput(input);
      preview = `${name}${summary ? ` · ${summary}` : ""}`;
    }
  } else if (isToolResultPartType(type)) {
    const name = resolvedToolName(part, names) || "Tool result";
    const value = toolResultPayload(part);
    if (typeof value === "string") {
      const command = parseCommandResult(value);
      if (command) {
        const status = command.status === "running" ? "running" : command.exitCode == null ? "completed" : `exit ${command.exitCode}`;
        const firstLine = command.output.split(/\r?\n/).find((line) => line.trim())?.trim();
        preview = `${name} · ${status}${command.wallTime ? ` · ${command.wallTime}` : ""}${firstLine ? ` · ${truncatePreview(firstLine, 90)}` : ""}`;
      } else {
        preview = `${name} · ${truncatePreview(value.replace(/\s+/g, " ").trim() || "(empty)", 120)}`;
      }
    } else {
      preview = `${name} · ${summarizeInput(value) || "completed"}`;
    }
  }
  if (parts.length > 1) preview += ` · +${parts.length - 1} more`;
  return preview;
}

function summarizeInput(value: unknown): string {
  const parsed = parseEmbeddedJSON(value);
  if (parsed == null) return "";
  if (typeof parsed === "string") return truncatePreview(parsed.replace(/\s+/g, " ").trim(), 110);
  if (Array.isArray(parsed)) return `${parsed.length} item${parsed.length === 1 ? "" : "s"}`;
  if (!isRecord(parsed)) return String(parsed);
  const entries = Object.entries(parsed).filter(([, field]) => field != null).slice(0, 3);
  return entries.map(([key, field]) => {
    if (Array.isArray(field)) return `${friendlyTypeLabel(key)}: ${field.length} items`;
    if (isRecord(field)) return `${friendlyTypeLabel(key)}: ${Object.keys(field).length} fields`;
    return `${friendlyTypeLabel(key)}: ${truncatePreview(String(field), 60)}`;
  }).join(" · ");
}

function truncatePreview(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
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
  const raw = isRecord(turn.raw) ? turn.raw : null;
  const rawType = stringRecordValue(raw?.type);
  if (
    raw &&
    (isToolCallPartType(rawType) ||
      isToolResultPartType(rawType) ||
      rawType === "tool_search_output" ||
      rawType === "tool_declarations")
  ) {
    return true;
  }
  const content = Array.isArray(raw?.content) ? raw.content.filter(isRecord) : [];
  if (
    content.length > 0 &&
    content.every((part) => {
      const type = stringRecordValue(part.type);
      return isToolCallPartType(type) || isToolResultPartType(type) || type === "tool_search_output";
    })
  ) {
    return true;
  }
  const text = turnText(turn).trimStart();
  if (startsWithCollapsibleBlock(text)) return true;
  const hiddenThinking = /^\*\*Thinking\*\*\s+_\((?:reasoning|thinking|redacted_thinking)\)_\s+(?:---\s+)?/s.exec(text);
  return hiddenThinking ? startsWithCollapsibleBlock(text.slice(hiddenThinking[0].length).trimStart()) : false;
}

function turnContainsVisualAsset(turn: Turn): boolean {
  return containsVisualAsset(turn.raw) || !!turn.attachments?.length;
}

function containsVisualAsset(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsVisualAsset(item, depth + 1));
  }
  if (!isRecord(value)) return false;
  const type = stringRecordValue(value.type);
  if (isImageVisualPart(type) || isFileVisualPart(type) || type === "image_generation_call") return true;
  return [value.content, value.output, value.parts, value.result].some((item) =>
    containsVisualAsset(item, depth + 1),
  );
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
    text.startsWith("**[custom_tool_call ") ||
    text.startsWith("**[tool_search_call") ||
    text.startsWith("**[tool_search_output") ||
    /^\*\*\[[a-z0-9_]+_call(?:_output)?(?:\s|\])/.test(text)
  );
}

function startsWithWebSearchCallBlock(text: string): boolean {
  return text.startsWith("**[web_search_call ");
}

function chatPreview(turn: Turn, toolNamesByCallID: Map<string, string>): string {
  const toolPreview = toolTurnPreview(turn, toolNamesByCallID);
  if (toolPreview) return truncatePreview(toolPreview, 180);
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
