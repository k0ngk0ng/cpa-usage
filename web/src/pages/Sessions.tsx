import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type {
  Filter,
  RangeKey,
  TimelineDetail,
  TimelinePage,
} from "../api/types";
import { copyToClipboard } from "../components/EventLogModal";
import SessionName from "../components/SessionName";
import FilterBar from "../components/FilterBar";
import {
  SessionRequests,
  RelatedSessions,
} from "../components/SessionRequests";
import RequestConversation from "../components/RequestConversation";
import { todayFilter } from "../hooks/useFilter";
import { useRefreshTick } from "../lib/refresh";
import { eventsReturnPath } from "../lib/timeline";
import { formatLatency, formatNumber, formatTimestamp } from "../lib/utils";

const button =
  "rounded border border-border bg-panel2 px-3 py-1.5 text-xs hover:text-ink disabled:opacity-40";
const selectors = [
  "session_id",
  "parent_session_id",
  "trace_id",
  "request_id",
  "execution_id",
] as const;
const labels = [
  "Session ID",
  "Parent session ID",
  "Trace / request ID",
  "Log request ID",
  "Execution ID",
];

export default function Sessions() {
  const [params, setParams] = useSearchParams();
  const serialized = params.toString();
  const key = params.get("key") || "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const tick = useRefreshTick();
  const filter = useMemo<Filter>(
    () => ({
      ...todayFilter,
      range: (params.get("range") || "today") as RangeKey,
      start: params.get("start") || undefined,
      end: params.get("end") || undefined,
      models: params.getAll("model"),
      sources: params.getAll("source"),
      apiKey: params.getAll("api_key"),
      authIndex: params.get("auth_index") || "",
      result:
        params.get("result") === "failed"
          ? "failed"
          : params.get("result") === "success"
            ? "success"
            : "",
      requestId: params.get("request_id") || "",
    }),
    [serialized],
  );
  const [data, setData] = useState<TimelinePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchField, setSearchField] = useState<string>(
    selectors.find((s) => params.has(s)) || "session_id",
  );
  const [search, setSearch] = useState(params.get(searchField) || "");
  useEffect(() => {
    const field = selectors.find((s) => params.has(s)) || "session_id";
    setSearchField(field);
    setSearch(params.get(field) || "");
  }, [serialized]);
  useEffect(() => {
    if (key) return;
    const c = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    const selection: Record<string, string> = {};
    selectors.forEach((s) => {
      if (params.get(s)) selection[s] = params.get(s)!;
    });
    api
      .timelines(filter, "session", page, selection, c.signal)
      .then((d) => {
        if (!c.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [serialized, tick]);
  function open(next: string) {
    const p = new URLSearchParams(params);
    if (next) p.set("key", next);
    else {
      p.delete("key");
      p.delete("origin_request");
      p.delete("focus_event");
      p.delete("context_session");
    }
    if (next.startsWith("session:")) p.set("context_session", next.slice(8));
    if (next && !next.startsWith("session:")) {
      p.set("origin_request", next);
      if (key.startsWith("session:")) p.set("context_session", key.slice(8));
    }
    setParams(p);
  }
  function updateFilter(next: Filter) {
    const p = new URLSearchParams(params);
    p.delete("page");
    [
      "range",
      "start",
      "end",
      "model",
      "source",
      "api_key",
      "auth_index",
      "result",
    ].forEach((k) => p.delete(k));
    p.set("range", next.range);
    if (next.range === "custom") {
      if (next.start) p.set("start", next.start);
      if (next.end) p.set("end", next.end);
    }
    next.models.forEach((v) => p.append("model", v));
    next.sources.forEach((v) => p.append("source", v));
    next.apiKey.forEach((v) => p.append("api_key", v));
    if (next.authIndex) p.set("auth_index", next.authIndex);
    if (next.result) p.set("result", next.result);
    setParams(p);
  }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Sessions</h1>
        <p className="mt-1 text-sm text-muted">
          Follow a conversation across requests. From Events, choose View
          session, then expand a request to read its input and response.
        </p>
      </div>
      {key ? (
        <SessionDetail
          key={key}
          timelineID={key}
          originRequest={params.get("origin_request") || ""}
          focusEvent={params.get("focus_event") || ""}
          contextSession={params.get("context_session") || ""}
          eventsPath={eventsReturnPath(params.get("events"))}
          onOpen={open}
        />
      ) : (
        <>
          <FilterBar filter={filter} onChange={updateFilter} showApiKey />
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const p = new URLSearchParams(params);
              selectors.forEach((s) => p.delete(s));
              p.delete("page");
              if (search.trim()) p.set(searchField, search.trim());
              setParams(p);
            }}
          >
            <select
              aria-label="ID type"
              className={button}
              value={searchField}
              onChange={(e) => setSearchField(e.target.value)}
            >
              {selectors.map((s, i) => (
                <option key={s} value={s}>
                  {labels[i]}
                </option>
              ))}
            </select>
            <input
              aria-label="Session search ID"
              placeholder="Exact ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-0 flex-1 basis-40 rounded border border-border bg-bg px-3 py-2 text-xs"
            />
            <button className={button}>Search</button>
            <button
              type="button"
              className={button}
              onClick={() => setParams({})}
            >
              Reset
            </button>
          </form>
          <p className="text-xs text-muted">
            {data && `${formatNumber(data.total)} sessions · `}Filters select
            sessions with matching activity; each session includes its full
            retained history.
          </p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {loading && (
            <p role="status" className="p-8 text-center text-muted">
              Loading sessions…
            </p>
          )}
          {data?.total === 0 && (
            <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted">
              No sessions match these filters. Records without a session ID
              remain available in{" "}
              <Link className="text-accent" to="/events">
                Events
              </Link>
              .
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data?.items.map((s) => (
              <button
                key={s.key}
                onClick={() => open(s.key)}
                className="min-w-0 space-y-3 rounded-lg border border-border bg-panel p-4 text-left hover:bg-panel2"
              >
                <SessionName id={s.key.slice(8)} />
                <div className="text-xs text-muted">
                  {formatTimestamp(new Date(s.started_at_ms).toISOString())}
                </div>
                <div className="text-sm">
                  {s.request_count}{" "}
                  {s.request_count === 1 ? "request" : "requests"} ·{" "}
                  {formatNumber(s.total_tokens)} tokens
                </div>
                <div className="flex flex-wrap justify-between gap-2 text-xs">
                  <span className={s.failed ? "text-danger" : "text-muted"}>
                    {s.failed
                      ? `${s.failed} failed usage records`
                      : "No failures reported"}
                  </span>
                  <span className="text-accent">Read session →</span>
                </div>
              </button>
            ))}
          </div>
          {data && data.total > data.page_size && (
            <div className="flex items-center justify-between text-xs">
              <button
                className={button}
                disabled={page <= 1 || loading}
                onClick={() => {
                  const p = new URLSearchParams(params);
                  p.set("page", String(page - 1));
                  setParams(p);
                }}
              >
                Previous
              </button>
              <span>
                Page {page} / {Math.ceil(data.total / data.page_size)}
              </span>
              <button
                className={button}
                disabled={page * data.page_size >= data.total || loading}
                onClick={() => {
                  const p = new URLSearchParams(params);
                  p.set("page", String(page + 1));
                  setParams(p);
                }}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SessionDetail({
  timelineID,
  originRequest,
  focusEvent,
  contextSession,
  eventsPath,
  onOpen,
}: {
  timelineID: string;
  originRequest: string;
  focusEvent: string;
  contextSession: string;
  eventsPath: string;
  onOpen: (key: string) => void;
}) {
  const [data, setData] = useState<TimelineDetail | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const tick = useRefreshTick();
  const isSession = timelineID.startsWith("session:");
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError("");
    api
      .timelineDetail(timelineID, 0, 0, c.signal, focusEvent)
      .then((d) => {
        if (!c.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [timelineID, focusEvent, tick, revision]);
  async function download() {
    if (!data) return;
    setExporting(true);
    try {
      let next = data;
      const items = [...data.items];
      while (next.next_cursor) {
        next = await api.timelineDetail(
          timelineID,
          next.next_cursor,
          data.snapshot,
        );
        items.push(...next.items);
      }
      const url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                ...data,
                items,
                next_cursor: 0,
                timing:
                  "Observed usage intervals; not a distributed span tree.",
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = isSession ? "session-usage.json" : "request-usage.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-panel"
      aria-label={isSession ? "Session detail" : "Request detail"}
    >
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button className={button} onClick={() => onOpen("")}>
            ← Sessions
          </button>
          <Link className={button} to={eventsPath}>
            ← Events
          </Link>
          {!isSession && contextSession && (
            <button
              className={button}
              onClick={() => onOpen(`session:${contextSession}`)}
            >
              Back to session requests
            </button>
          )}
          <button
            className={button}
            disabled={loading}
            onClick={() => setRevision((v) => v + 1)}
          >
            Refresh
          </button>
          <button
            className={button}
            disabled={!data || exporting}
            onClick={download}
          >
            {exporting ? "Exporting…" : "Export usage JSON"}
          </button>
        </div>
        <h2 className="text-base font-semibold">
          {isSession ? "Session" : "Request"}
        </h2>
        {isSession ? (
          <div className="flex items-start gap-3">
            <SessionName id={timelineID.slice(8)} fullID revision={revision} />
            <CopySessionID id={timelineID.slice(8)} />
          </div>
        ) : (
          <div className="break-all font-mono text-xs text-muted">
            {timelineID.slice(timelineID.indexOf(":") + 1)}
          </div>
        )}
        {data && !data.referenced_only && (
          <>
            <div className="flex flex-wrap gap-3 text-xs">
              <span>
                {data.summary.request_count}{" "}
                {data.summary.request_count === 1 ? "request" : "requests"}
              </span>
              <span>{formatNumber(data.summary.total_tokens)} tokens</span>
              <span>
                {formatLatency(
                  data.summary.ended_at_ms - data.summary.started_at_ms,
                )}{" "}
                observed
              </span>
              {data.summary.failed > 0 && (
                <span className="text-danger">
                  {data.summary.failed} failed usage records
                </span>
              )}
            </div>
            <p className="text-xs text-muted">
              {formatTimestamp(
                new Date(data.summary.started_at_ms).toISOString(),
              )}{" "}
              · Full retained history, independent of list filters.
            </p>
          </>
        )}
        {data?.referenced_only && (
          <div className="rounded border border-warn/30 bg-warn/5 p-3 text-sm">
            <strong>Referenced session · no own retained usage</strong>
            <p className="mt-2 text-muted">
              {data.referencing_records} retained usage records reference this
              parent
              {data.child_sessions
                ? ` across ${data.child_sessions} child sessions`
                : ""}
              . Its own requests are unavailable: they may predate session
              tracking, have expired, or never have emitted usage. Read the
              observed child sessions below.
            </p>
          </div>
        )}
        {!isSession && data && (
          <div className="flex flex-wrap gap-2">
            {data.sessions.length ? (
              data.sessions.map((s) => (
                <button
                  className={button}
                  key={s.id}
                  onClick={() => onOpen(`session:${s.id}`)}
                >
                  <span className="mb-1 block text-accent">View session →</span>
                  <SessionName id={s.id} />
                </button>
              ))
            ) : (
              <p className="text-xs text-muted">
                No session ID was reported for this request. Its content is
                available here when the request log is retained.
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {loading && !data && (
          <p role="status" className="text-sm text-muted">
            Loading session…
          </p>
        )}
      </div>
      {data &&
        (isSession ? (
          <>
            {!data.referenced_only && (
              <SessionRequests
                key={`${timelineID}:${data.snapshot}`}
                detail={data}
                originRequest={originRequest}
                focusEvent={focusEvent}
                onOpen={onOpen}
              />
            )}
            <RelatedSessions key={timelineID} detail={data} onOpen={onOpen} />
          </>
        ) : (
          <RequestConversation
            key={`${timelineID}:${data.snapshot}`}
            requestKey={timelineID}
            snapshot={data.snapshot}
            focusEvent={focusEvent}
          />
        ))}
    </section>
  );
}

function CopySessionID({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="shrink-0 text-xs text-accent"
      onClick={() => {
        void copyToClipboard(id).then(setCopied);
      }}
    >
      {copied ? "Copied" : "Copy ID"}
    </button>
  );
}
