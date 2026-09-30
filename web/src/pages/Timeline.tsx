import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { api } from "../api/client";
import type {
  Filter,
  RangeKey,
  TimelineDetail,
  TimelinePage,
  TimelineSummary,
  UsageEventRecord,
} from "../api/types";
import FilterBar from "../components/FilterBar";
import EventLogModal from "../components/EventLogModal";
import { defaultFilter } from "../hooks/useFilter";
import { useRefreshTick } from "../lib/refresh";
import {
  formatCost,
  formatLatency,
  formatNumber,
  formatTimestamp,
} from "../lib/utils";
import {
  barPosition,
  observedEnd,
  timelineGroups,
  timelineKey,
  timelineURL,
} from "../lib/timeline";

function countLabel(count: number, noun: string) {
  return `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}

const button =
  "rounded border border-border bg-panel2 px-3 py-1.5 text-xs hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed";
const input =
  "min-w-0 rounded border border-border bg-bg px-3 py-2 text-xs text-ink";
const selectors = [
  "trace_id",
  "request_id",
  "execution_id",
  "session_id",
  "parent_session_id",
] as const;
const labels = [
  "Trace / request ID",
  "Log request ID",
  "Execution ID",
  "Session ID",
  "Parent session ID",
];

export default function Timeline() {
  const [params, setParams] = useSearchParams();
  const serialized = params.toString();
  const mode = params.get("mode") === "session" ? "session" : "request";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const key = params.get("key") || "";
  const filter = useMemo<Filter>(
    () => ({
      ...defaultFilter,
      range: (params.get("range") || "24h") as RangeKey,
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchField, setSearchField] = useState<string>(
    selectors.find((s) => params.has(s)) || "trace_id",
  );
  const [search, setSearch] = useState(params.get(searchField) || "");
  const tick = useRefreshTick();
  const query = new URLSearchParams(params);
  query.delete("key");
  const listQuery = query.toString();

  useEffect(() => {
    const found = selectors.find((s) => params.has(s)) || "trace_id";
    setSearchField(found);
    setSearch(params.get(found) || "");
  }, [listQuery]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    const selection: Record<string, string> = {};
    selectors.forEach((s) => {
      if (params.get(s)) selection[s] = params.get(s)!;
    });
    api
      .timelines(filter, mode, page, selection, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setData(next);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e.message || e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [listQuery, tick]);

  function updateFilter(next: Filter) {
    const p = new URLSearchParams(params);
    p.delete("page");
    p.delete("key");
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
  function selectKey(next: string) {
    const p = new URLSearchParams(params);
    if (next) p.set("key", next);
    else p.delete("key");
    setParams(p);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Usage timeline</h1>
          <p className="mt-1 text-sm text-muted">
            Explore model executions across requests and sessions.
          </p>
        </div>
        <div
          className="flex gap-1 rounded-lg border border-border bg-panel p-1"
          aria-label="Timeline grouping"
        >
          {(["request", "session"] as const).map((m) => (
            <button
              key={m}
              aria-pressed={mode === m}
              className={clsx(
                button,
                mode === m && "text-accent border-accent",
              )}
              onClick={() => {
                const p = new URLSearchParams(params);
                p.set("mode", m);
                p.delete("page");
                p.delete("key");
                setParams(p);
              }}
            >
              {m === "request" ? "Requests" : "Sessions"}
            </button>
          ))}
        </div>
      </div>
      <details className="rounded-lg border border-border bg-panel px-4 py-3 text-xs text-muted">
        <summary className="cursor-pointer text-ink">
          How to read this timeline
        </summary>
        <p className="mt-2 leading-relaxed">
          Bars show usage records from their reported timestamp through
          timestamp + latency. The observed envelope is not total HTTP duration.
          Gaps are unobserved time; overlapping bars do not prove parallel
          calls. Multiple records can represent retries or additional model
          accounting, without enough data to distinguish them. TTFT is shown
          separately because its clock can have a different start and may fall
          back to the first packet.
        </p>
        <p className="mt-2 leading-relaxed">
          Session links are CPA-reported associations, not span parentage.
          Missing IDs stay unknown; legacy request IDs group older records.
          Imported timestamps and timings depend on the source. Only retained,
          ingested usage is visible; requests with no usage and in-progress
          calls may be absent.
        </p>
      </details>
      <details open={!key} className={key ? "hidden lg:block" : ""}>
        <summary className="mb-3 cursor-pointer text-xs text-muted">
          Filters{key ? " · expand to change the results" : ""}
        </summary>
        <FilterBar filter={filter} onChange={updateFilter} showApiKey />
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const p = new URLSearchParams(params);
            selectors.forEach((s) => p.delete(s));
            p.delete("page");
            p.delete("key");
            if (search.trim()) p.set(searchField, search.trim());
            setParams(p);
          }}
        >
          <select
            className={input}
            aria-label="ID type"
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
            className={clsx(input, "flex-1 basis-40")}
            aria-label="Timeline ID"
            placeholder="Exact ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className={button}>Search</button>
          <button
            type="button"
            className={button}
            onClick={() => setParams(new URLSearchParams({ mode }))}
          >
            Reset
          </button>
        </form>
      </details>
      <div
        className={clsx(
          "grid items-start gap-4",
          key && "lg:grid-cols-[300px_minmax(0,1fr)]",
        )}
      >
        <section
          className={clsx(
            "min-w-0",
            key && "hidden lg:block lg:max-h-[75vh] lg:overflow-y-auto lg:pr-1",
          )}
          aria-label="Timeline results"
          aria-busy={loading}
        >
          <p className="mb-3 text-xs text-muted">
            {data
              ? countLabel(data.total, mode === "session" ? "session" : "request group")
              : ""}{" "}
            · Filters select groups; summaries include all their retained
            records.
          </p>
          {error && <ErrorBox message={error} />}
          {loading && (
            <p className="py-8 text-center text-sm text-muted" role="status">
              Loading timelines…
            </p>
          )}
          {!loading && data?.items.length === 0 && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted">
              No {mode === "session" ? "sessions" : "requests"} match these
              filters.
              {mode === "session" && (
                <p className="mt-2">
                  Session IDs require newer CPA usage records. Older records
                  remain available under Requests.
                </p>
              )}
            </div>
          )}
          <div
            className={clsx(
              "grid gap-2",
              !key && "md:grid-cols-2 xl:grid-cols-3",
            )}
          >
            {data?.items.map((item) => (
              <button
                key={item.key}
                onClick={() => selectKey(item.key)}
                className={clsx(
                  "min-w-0 rounded-lg border bg-panel p-4 text-left hover:bg-panel2",
                  key === item.key ? "border-accent" : "border-border",
                )}
              >
                <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted">
                    {formatTimestamp(
                      new Date(item.started_at_ms).toISOString(),
                    )}
                  </span>
                  <Outcome summary={item} />
                </div>
                <div className="truncate text-sm font-medium">
                  {item.model || "Unknown model"}
                  {item.model_count > 1 && (
                    <span className="text-muted"> +{item.model_count - 1}</span>
                  )}
                </div>
                <div
                  title={item.key.slice(item.key.indexOf(":") + 1)}
                  className="my-2 truncate font-mono text-[11px] text-muted"
                >
                  {item.kind === "event" ? "Unlinked record · " : ""}
                  {item.key.slice(item.key.indexOf(":") + 1)}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                  <span>{countLabel(item.records, "record")}</span>
                  {mode === "session" && (
                    <span>{countLabel(item.request_count, "request")}</span>
                  )}
                  <span>
                    {formatLatency(item.ended_at_ms - item.started_at_ms)}{" "}
                    observed
                  </span>
                  <span>{formatNumber(item.total_tokens)} tokens</span>
                </div>
              </button>
            ))}
          </div>
          {data && data.total > 0 && (
            <div className="mt-4 flex items-center justify-between gap-2 text-xs text-muted">
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
                {page} / {Math.max(1, Math.ceil(data.total / data.page_size))}
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
        </section>
        {key && (
          <TimelineView
            key={key}
            timelineID={key}
            onClose={() => selectKey("")}
            onSelect={selectKey}
          />
        )}
      </div>
    </div>
  );
}

function TimelineView({
  timelineID,
  onClose,
  onSelect,
}: {
  timelineID: string;
  onClose: () => void;
  onSelect: (key: string) => void;
}) {
  const [data, setData] = useState<TimelineDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [log, setLog] = useState<UsageEventRecord | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const controller = useRef<AbortController>();
  const tick = useRefreshTick();
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    setLoading(true);
    setError("");
    api
      .timelineDetail(timelineID, 0, 0, c.signal)
      .then((next) => {
        if (!c.signal.aborted) setData(next);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [timelineID, tick, revision]);

  async function loadMore() {
    if (!data || loading) return;
    const c = controller.current!;
    setLoading(true);
    setError("");
    try {
      const next = await api.timelineDetail(
        timelineID,
        data.next_cursor,
        data.snapshot,
        c.signal,
      );
      if (!c.signal.aborted)
        setData({ ...next, items: [...data.items, ...next.items] });
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }
  async function download() {
    if (!data || exporting) return;
    const c = controller.current!;
    setExporting(true);
    setError("");
    try {
      let next = data;
      const items = [...data.items];
      while (next.next_cursor) {
        next = await api.timelineDetail(
          timelineID,
          next.next_cursor,
          data.snapshot,
          c.signal,
        );
        items.push(...next.items);
      }
      if (c.signal.aborted) return;
      const payload = {
        ...data,
        items,
        next_cursor: 0,
        timing:
          "Observed usage envelope; not HTTP duration or a distributed span tree.",
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "usage-timeline.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  const summary = data?.summary;
  const groups = useMemo(
    () => timelineGroups(data?.items || []),
    [data?.items],
  );
  const sessions = [
    ...new Set(data?.items.map((e) => e.session_id).filter(Boolean)),
  ];
  const parents = [
    ...new Set(data?.items.map((e) => e.parent_session_id).filter(Boolean)),
  ];
  const duration = summary
    ? Math.max(1, summary.ended_at_ms - summary.started_at_ms)
    : 1;
  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-panel"
      aria-label="Timeline detail"
      aria-busy={loading}
    >
      <div className="space-y-3 border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button className={button} onClick={onClose}>
            ← Results
          </button>
          <button
            className={button}
            disabled={loading || exporting}
            onClick={() => setRevision((v) => v + 1)}
          >
            Refresh
          </button>
          <h2 className="mr-auto text-sm font-semibold">
            {timelineID.startsWith("session:") ? "Session" : "Request"} timeline
          </h2>
          <button
            className={button}
            disabled={!data || exporting}
            onClick={download}
          >
            {exporting ? "Exporting…" : "Export JSON"}
          </button>
        </div>
        <div className="break-all font-mono text-xs text-muted">
          {timelineID.slice(timelineID.indexOf(":") + 1)}
        </div>
        {summary && (
          <>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
              <span>
                <strong className="text-lg">
                  {formatLatency(summary.ended_at_ms - summary.started_at_ms)}
                </strong>{" "}
                <span className="text-muted">observed</span>
              </span>
              <span>{countLabel(summary.records, "record")}</span>
              <span>{formatNumber(summary.total_tokens)} tokens</span>
              <Outcome summary={summary} />
            </div>
            <p className="text-[11px] text-muted">
              {formatTimestamp(new Date(summary.started_at_ms).toISOString())} ·
              Full retained group, independent of list filters.
            </p>
          </>
        )}
        {(sessions.length > 0 || parents.length > 0) && (
          <div className="flex flex-wrap gap-2 text-xs">
            {sessions.map((id) => (
              <button
                className={clsx(button, "max-w-full truncate text-accent")}
                key={`session:${id}`}
                title={id}
                onClick={() => onSelect(`session:${id}`)}
              >
                Session · {id}
              </button>
            ))}
            {parents.map((id) => (
              <button
                className={clsx(button, "max-w-full truncate text-accent")}
                key={`parent:${id}`}
                title={id}
                onClick={() => onSelect(`session:${id}`)}
              >
                Parent session · {id}
              </button>
            ))}
          </div>
        )}
        {timelineID.startsWith("session:") && (
          <Link
            className="inline-block text-xs text-accent"
            to={`/timeline?${new URLSearchParams({ mode: "session", range: "all", parent_session_id: timelineID.slice(8) })}`}
          >
            Browse child sessions →
          </Link>
        )}
      </div>
      {error && (
        <div className="p-4">
          <ErrorBox message={error} />
        </div>
      )}
      {!data && loading && (
        <p className="p-10 text-center text-muted" role="status">
          Loading usage records…
        </p>
      )}
      {data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 p-4 text-[11px] text-muted">
            <span>
              Usage records · <span className="text-accent">● success</span> /{" "}
              <span className="text-danger">● failed</span>
            </span>
            <label>
              Zoom{" "}
              <select
                aria-label="Timeline zoom"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="ml-2 rounded border border-border bg-panel2 px-2 py-1"
              >
                {[1, 2, 4, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div
            className="overflow-x-auto overscroll-x-contain"
            tabIndex={0}
            aria-label="Execution waterfall"
          >
            <div style={{ width: `${zoom * 100}%` }} className="px-4 pb-4">
              <div className="grid grid-cols-[110px_minmax(0,1fr)] sm:grid-cols-[220px_minmax(0,1fr)] gap-3 pb-2 text-[10px] text-muted">
                <span>Model / credential</span>
                <div className="flex justify-between">
                  {[0, 0.25, 0.5, 0.75, 1].map((v) => (
                    <span
                      key={v}
                      className={
                        v === 0.25 || v === 0.75 ? "hidden sm:inline" : ""
                      }
                    >
                      {v === 0 ? "0 ms" : formatLatency(duration * v)}
                    </span>
                  ))}
                </div>
              </div>
              {groups.map((group) => (
                <div key={group.key} className="mb-3">
                  {summary?.kind === "session" && (
                    <div className="mb-1 flex items-center gap-2 bg-panel2 px-2 py-2 text-xs">
                      <button
                        className="min-w-0 flex-1 truncate text-left font-mono"
                        aria-expanded={!collapsed.has(group.key)}
                        onClick={() =>
                          setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return next;
                          })
                        }
                      >
                        {collapsed.has(group.key) ? "▸" : "▾"}{" "}
                        {group.key.slice(group.key.indexOf(":") + 1)} ·{" "}
                        {group.events.length} loaded
                      </button>
                      <button
                        className="shrink-0 text-accent"
                        onClick={() => onSelect(group.key)}
                      >
                        Open request
                      </button>
                    </div>
                  )}
                  {!collapsed.has(group.key) &&
                    group.events.map((event) => (
                      <div key={event.event_key}>
                        <button
                          className={clsx(
                            "grid w-full grid-cols-[110px_minmax(0,1fr)] sm:grid-cols-[220px_minmax(0,1fr)] items-center gap-3 rounded px-1 py-2 text-left hover:bg-panel2",
                            expanded === event.event_key && "bg-panel2",
                          )}
                          aria-expanded={expanded === event.event_key}
                          aria-label={`${event.model}, ${event.failed ? "failed" : "success"}, ${formatLatency(event.latency_ms)}`}
                          onClick={() =>
                            setExpanded(
                              expanded === event.event_key
                                ? null
                                : event.event_key,
                            )
                          }
                        >
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium">
                              {event.model}
                              {event.timestamp_inferred
                                ? " · inferred time"
                                : ""}
                            </div>
                            <div className="truncate text-[10px] text-muted">
                              {event.provider} ·{" "}
                              {event.source_display ||
                                event.auth_index ||
                                "Unknown credential"}
                            </div>
                          </div>
                          <div
                            className="relative h-9 border-x border-border"
                            style={{
                              backgroundImage:
                                "linear-gradient(to right, #262b3644 1px, transparent 1px)",
                              backgroundSize: "25% 100%",
                            }}
                          >
                            <div
                              className={clsx(
                                "absolute top-1 h-3 rounded-sm",
                                event.failed ? "bg-danger" : "bg-accent",
                              )}
                              style={barPosition(
                                Date.parse(event.timestamp),
                                observedEnd(event),
                                summary!.started_at_ms,
                                duration,
                              )}
                            />
                            <span className="absolute bottom-0 right-1 text-[10px] text-muted">
                              {formatLatency(Math.max(0, event.latency_ms))}
                              <span className="hidden sm:inline">
                                {" "}
                                · {formatNumber(event.total_tokens)} tokens
                                {event.ttft_ms > 0
                                  ? ` · TTFT ${formatLatency(event.ttft_ms)}`
                                  : ""}
                              </span>
                            </span>
                          </div>
                        </button>
                        {expanded === event.event_key && (
                          <EventDetail
                            event={event}
                            origin={summary!.started_at_ms}
                            onLog={() => setLog(event)}
                          />
                        )}
                      </div>
                    ))}
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4 text-xs text-muted">
            <span>
              {data.items.length} / {summary?.records} records loaded
              {data.next_cursor > 0 &&
                " · Earlier records may appear as more pages load"}
            </span>
            {data.next_cursor > 0 && (
              <button className={button} disabled={loading} onClick={loadMore}>
                {loading ? "Loading…" : "Load more records"}
              </button>
            )}
          </div>
          <p className="px-4 pb-4 text-[11px] leading-relaxed text-muted">
            Observed intervals may include additional model accounting. No retry
            order or parent span is inferred. TTFT is a reported duration, not a
            marker on this axis. Refresh to include newly ingested records.
          </p>
        </>
      )}
      {log && <EventLogModal event={log} onClose={() => setLog(null)} />}
    </section>
  );
}

function EventDetail({
  event,
  origin,
  onLog,
}: {
  event: UsageEventRecord;
  origin: number;
  onLog: () => void;
}) {
  const fields: Record<string, string> = {
    "Execution ID": event.execution_id || "Unavailable (not reported)",
    "Trace ID": event.trace_id || "Unavailable (using request ID when present)",
    "Log request ID": event.request_id || "Unavailable",
    "Event key": event.event_key,
    Started: event.timestamp,
    "Timestamp source": event.timestamp_inferred
      ? "Ingest time (source timestamp missing)"
      : event.event_key.startsWith("import:")
        ? "Imported snapshot"
        : "Reported / historical",
    Offset: formatLatency(Math.max(0, Date.parse(event.timestamp) - origin)),
    "Reported latency": formatLatency(event.latency_ms),
    TTFT: event.ttft_ms > 0 ? formatLatency(event.ttft_ms) : "Unavailable",
    "Provider / executor": [event.provider, event.executor_type]
      .filter(Boolean)
      .join(" / "),
    Credential: event.source_display || event.auth_index || "Unknown",
    "Auth index": event.auth_index || "Unknown",
    "API group": event.api_group_display || "Unknown",
    Endpoint: event.endpoint || "Unknown",
    "Response model": event.response_model || "Not reported",
    Streaming: event.stream == null ? "Unknown" : event.stream ? "Yes" : "No",
    Generate: event.generate ? "Yes" : "No",
    Session: event.session_id || "Unknown",
    "Parent session": event.parent_session_id || "Unknown",
    "Session markers":
      [
        event.node_kind,
        event.is_fork ? "fork" : "",
        event.is_compaction ? "compaction" : "",
      ]
        .filter(Boolean)
        .join(" · ") || "None reported",
    "New input": formatNumber(event.input_tokens),
    "Cache read": formatNumber(event.cache_read_tokens),
    "Cache write": formatNumber(event.cache_creation_tokens),
    Output: formatNumber(event.output_tokens),
    Reasoning: formatNumber(event.reasoning_tokens),
    "Estimated cost": formatCost(event.cost),
    "Reasoning effort": event.reasoning_effort || "Unknown",
    "Service tier": event.service_tier || "Unknown",
    "Response tier": event.response_service_tier || "Unknown",
  };
  return (
    <div className="mb-3 rounded border border-border bg-bg p-3 text-xs">
      <div className="mb-3 flex gap-2">
        <span className={event.failed ? "text-danger" : "text-accent"}>
          {event.failed ? "Failed" : "Success"}
          {event.fail_status_code ? ` · ${event.fail_status_code}` : ""}
        </span>
        {event.request_id && (
          <button onClick={onLog} className="ml-auto text-accent">
            Open request log →
          </button>
        )}
      </div>
      {event.fail_body && (
        <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-danger/10 p-2 text-danger">
          {event.fail_body}
        </pre>
      )}
      <dl className="grid grid-cols-[100px_minmax(0,1fr)] sm:grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-2">
        {Object.entries(fields).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="break-all font-mono text-[11px]">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Outcome({ summary }: { summary: TimelineSummary }) {
  return (
    <span
      className={clsx(
        "shrink-0 text-[11px]",
        summary.failed ? "text-danger" : "text-accent",
      )}
    >
      {summary.failed
        ? `${summary.failed} / ${summary.records} failed`
        : "All successful"}
    </span>
  );
}
function ErrorBox({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger break-words"
    >
      {message}
    </div>
  );
}
