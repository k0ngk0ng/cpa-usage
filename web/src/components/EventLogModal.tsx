import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, HttpError } from "../api/client";
import type { APIResponseAttempt, EventLogEntry, UsageEventRecord } from "../api/types";
import { formatBytes, formatTimestamp } from "../lib/utils";
import {
  extractRequestTurns,
  extractResponseJSON,
  extractResponseStream,
  isSafeDataImageURL,
  streamToMarkdown,
} from "../lib/protocol";
import type { Turn } from "../lib/protocol";

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
      return turns
        ? { kind: "chat" as const, turns, label: `${turns.length} turn${turns.length > 1 ? "s" : ""}` }
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
          },
        ],
        label: "stream",
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
          },
        ],
        label: "json",
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
      <div className="sticky top-0 z-10 -mx-1 flex items-center gap-1 bg-panel2/95 px-1 py-1 backdrop-blur">
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
        <ChatView turns={projection.turns} />
      ) : (
        <CodeBlock text={raw} />
      )}
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
      <div className="sticky top-0 z-10 -mx-1 flex items-center gap-1 bg-panel2/95 px-1 py-1 backdrop-blur">
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
    turns.push({ role: "user", text: fenceMarkdown(requestRaw.trim()) });
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
    };
  }
  const json = extractResponseJSON(raw);
  if (json) {
    return {
      role: "assistant",
      text: streamToMarkdown(json),
      encrypted: json.encrypted,
      hiddenType: json.hiddenType,
    };
  }
  return { role: "assistant", text: fenceMarkdown(raw.trim()) };
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
  const toggleTool = (index: number) => {
    setExpandedTools((current) => {
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
        const bubbleClass = isTool ? "chat-bubble-tool" : chatBubbleClass(turn.role);
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
                <span className={clsx("role-badge", roleBadgeClass(turn.role))}>{turn.role}</span>
                <span className="chat-turn">#{index + 1}</span>
                {isTool && (
                  <button className="chat-toggle" onClick={() => toggleTool(index)}>
                    {collapsed ? "Expand" : "Collapse"}
                  </button>
                )}
              </div>
              {collapsed ? (
                <div className="chat-preview">{chatPreview(turn)}</div>
              ) : (
                <>
                  <div className="chat-body prose-md">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      urlTransform={markdownUrlTransform}
                      components={{ strong: MarkdownStrong }}
                    >
                      {turnText(turn)}
                    </ReactMarkdown>
                  </div>
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

function isToolTurn(turn: Turn): boolean {
  if (turn.role.toLowerCase() === "tool") return true;
  const text = turnText(turn).trimStart();
  if (startsWithToolBlock(text)) return true;
  const hiddenThinking = /^\*\*Thinking\*\*\s+_\((?:reasoning|thinking|redacted_thinking)\)_\s+(?:---\s+)?/s.exec(text);
  return hiddenThinking ? startsWithToolBlock(text.slice(hiddenThinking[0].length).trimStart()) : false;
}

function startsWithToolBlock(text: string): boolean {
  return text.startsWith("**[tool_use ") || text.startsWith("**[tool_result");
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
