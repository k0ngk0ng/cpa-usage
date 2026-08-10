import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import FilterBar from "../components/FilterBar";
import Table, { Column } from "../components/Table";
import EventLogModal from "../components/EventLogModal";
import { api } from "../api/client";
import { todayFilter, useFilter } from "../hooks/useFilter";
import { useRefreshTick } from "../lib/refresh";
import { formatCost, formatLatency, formatNumber, formatTimestamp } from "../lib/utils";
import type { FormEvent } from "react";
import type { Filter, RangeKey, ResultFilter, UsageEventRecord, UsageEventsPage } from "../api/types";

const PAGE_SIZES = [20, 50, 100, 500, 1000];
const RANGE_KEYS: RangeKey[] = ["all", "today", "4h", "8h", "12h", "24h", "2d", "3d", "4d", "5d", "6d", "7d", "30d", "custom"];
const RESULT_KEYS: ResultFilter[] = ["", "success", "failed"];

export default function EventsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilter = useMemo(() => filterFromSearch(searchParams), [searchParams]);
  const { filter, setFilter } = useFilter(initialFilter);
  const [requestInput, setRequestInput] = useState(initialFilter.requestId);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [data, setData] = useState<UsageEventsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<UsageEventRecord | null>(null);
  const [autoOpenedRequestId, setAutoOpenedRequestId] = useState("");
  const tick = useRefreshTick();

  const applyFilter = (next: Filter, replace = true) => {
    setFilter(next);
    setPage(1);
    setSearchParams(searchFromFilter(next), { replace });
  };

  // Reset to page 1 when filter changes.
  useEffect(() => {
    setPage(1);
  }, [filter]);

  useEffect(() => {
    setRequestInput(filter.requestId);
  }, [filter.requestId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .events(filter, page, pageSize)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, page, pageSize, tick]);

  useEffect(() => {
    if (!filter.requestId) {
      setAutoOpenedRequestId("");
      return;
    }
    const item = data?.Items?.[0];
    if (
      data?.Items.length === 1 &&
      item?.request_id === filter.requestId &&
      autoOpenedRequestId !== filter.requestId
    ) {
      setSelected(item);
      setAutoOpenedRequestId(filter.requestId);
    }
  }, [autoOpenedRequestId, data, filter.requestId]);

  const handleRequestSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const requestId = requestInput.trim();
    const next: Filter = { ...filter, requestId };
    if (requestId) {
      next.range = "all";
      next.start = undefined;
      next.end = undefined;
    }
    applyFilter(next, false);
  };

  const clearRequestSearch = () => {
    setRequestInput("");
    setSelected(null);
    applyFilter({ ...filter, requestId: "" }, false);
  };

  const cols: Column<UsageEventRecord>[] = [
    {
      header: "Time / Status",
      className: "w-44",
      cellClassName: "whitespace-nowrap",
      cell: (r) => {
        const d = r.timestamp ? new Date(r.timestamp) : null;
        const ok = d && !Number.isNaN(d.getTime());
        const date = ok ? `${String(d!.getMonth() + 1).padStart(2, "0")}-${String(d!.getDate()).padStart(2, "0")}` : "—";
        const time = ok ? `${String(d!.getHours()).padStart(2, "0")}:${String(d!.getMinutes()).padStart(2, "0")}:${String(d!.getSeconds()).padStart(2, "0")}` : "";
        return (
          <div className="flex items-start gap-2" title={ok ? formatTimestamp(r.timestamp) : ""}>
            <span
              title={r.failed ? `Failed${r.fail_status_code ? ` (${r.fail_status_code})` : ""}` : "Success"}
              className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${r.failed ? "bg-danger" : "bg-success"}`}
            />
            <div className="min-w-0">
              <div className="text-[10px] text-muted">{date}</div>
              <div className="font-mono">{time}</div>
              {r.request_id && (
                <div className="max-w-36 truncate font-mono text-[10px] text-muted" title={r.request_id}>
                  {r.request_id}
                </div>
              )}
              {!r.generate && <div className="text-[10px] text-warn">result only</div>}
            </div>
          </div>
        );
      },
    },
    {
      header: "Model / Provider",
      className: "w-52",
      cellClassName: "max-w-52",
      cell: (r) => {
        const tier = eventTier(r);
        return (
          <div className="min-w-0">
            <div className="truncate font-mono" title={r.model}>{r.model || "—"}</div>
            {r.alias && r.alias !== r.model && (
              <div className="truncate text-[10px] text-muted" title={r.alias}>{r.alias}</div>
            )}
            <div className="mt-0.5 truncate text-[10px] text-muted" title={eventProvider(r)}>
              {eventProvider(r)}
            </div>
            {tier && <div className="text-[10px] text-muted truncate">tier {tier}</div>}
          </div>
        );
      },
    },
    {
      header: "API / Source",
      className: "w-48",
      cellClassName: "max-w-48",
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate" title={r.api_group_key}>{r.api_group_display || r.api_group_key || "—"}</div>
          {r.api_group_display && r.api_group_display !== r.api_group_key && (
            <div className="text-[10px] text-muted font-mono truncate">{r.api_group_key}</div>
          )}
          <div className="mt-0.5 truncate text-[10px] text-muted" title={r.source}>
            {r.source_display || r.source || "—"}
            {r.auth_index && <span className="font-mono"> #{r.auth_index}</span>}
          </div>
        </div>
      ),
    },
    {
      header: "Endpoint",
      className: "w-36",
      cellClassName: "max-w-36",
      cell: (r) => (
        <span className="block truncate" title={r.endpoint}>
          {r.endpoint || "—"}
        </span>
      ),
    },
    {
      header: "Latency",
      className: "w-20",
      align: "right",
      cellClassName: "whitespace-nowrap",
      cell: (r) => (
        <div title={r.ttft_ms ? `TTFT ${formatLatency(r.ttft_ms)}` : ""}>
          <div>{formatLatency(r.latency_ms)}</div>
          {r.ttft_ms > 0 && <div className="text-[10px] text-muted">TTFT {formatLatency(r.ttft_ms)}</div>}
        </div>
      ),
    },
    {
      header: "Input",
      className: "w-40",
      align: "right",
      cellClassName: "whitespace-nowrap font-medium",
      cell: (r) => (
        <div title={`New ${formatNumber(r.input_tokens)} · Cache read ${formatNumber(r.cached_tokens)} · Cache write ${formatNumber(r.cache_creation_tokens)}`}>
          <div>{formatNumber(eventInputTokens(r))}</div>
          <div className="max-w-36 truncate text-[10px] font-normal text-muted">
            N {formatNumber(r.input_tokens)} · R {formatNumber(r.cached_tokens)} · W {formatNumber(r.cache_creation_tokens)}
          </div>
        </div>
      ),
    },
    {
      header: "Output total",
      className: "w-24",
      align: "right",
      cellClassName: "whitespace-nowrap",
      cell: (r) => (
        <div>
          <div>{formatNumber(r.output_tokens)}</div>
          <div className="text-[10px] text-muted">reason {formatNumber(r.reasoning_tokens)} included</div>
        </div>
      ),
    },
    {
      header: "Total",
      className: "w-20",
      align: "right",
      cellClassName: "whitespace-nowrap font-medium",
      cell: (r) => formatNumber(r.total_tokens),
    },
    { header: "Cost", className: "w-16", align: "right", cellClassName: "whitespace-nowrap", cell: (r) => formatCost(r.cost) },
  ];

  const rows = data?.Items || [];

  return (
    <div>
      <FilterBar filter={filter} onChange={applyFilter} showApiKey />
      <form
        onSubmit={handleRequestSearch}
        className="mb-4 grid grid-cols-[auto_auto_1fr] items-center gap-2 rounded-lg border border-border bg-panel p-3 sm:flex sm:flex-wrap"
      >
        <input
          aria-label="request_id"
          type="search"
          placeholder="request_id"
          value={requestInput}
          onChange={(e) => setRequestInput(e.target.value)}
          className="col-span-3 w-full min-w-0 rounded border border-border bg-panel2 px-2 py-1 font-mono text-xs sm:col-span-1 sm:min-w-[18rem] sm:max-w-xl sm:flex-1"
        />
        <button
          type="submit"
          className="px-3 py-1 rounded text-xs border border-accent bg-accent text-bg hover:brightness-110"
        >
          Search
        </button>
        {filter.requestId && (
          <button
            type="button"
            onClick={clearRequestSearch}
            className="px-3 py-1 rounded text-xs border border-border bg-panel2 text-muted hover:text-ink"
          >
            Clear
          </button>
        )}
      </form>
      {err && (
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg p-3 text-sm mb-4">
          {err}
        </div>
      )}

      <div className="xl:hidden">
        <MobileEventList
          rows={rows}
          loading={loading && !data}
          onSelect={setSelected}
        />
      </div>
      <div className="hidden xl:block">
        <Table<UsageEventRecord>
          columns={cols}
          rows={rows}
          rowKey={eventReactKey}
          loading={loading && !data}
          empty="No events match the current filter."
          onRowClick={(r) => r.request_id && setSelected(r)}
        />
      </div>

      <Pagination
        total={data?.Total || 0}
        page={data?.Page || page}
        pageSize={pageSize}
        totalPages={data?.TotalPages || 0}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />

      {selected && (
        <EventLogModal event={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function MobileEventList({
  rows,
  loading,
  onSelect,
}: {
  rows: UsageEventRecord[];
  loading: boolean;
  onSelect: (event: UsageEventRecord) => void;
}) {
  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-panel px-4 py-8 text-center text-xs text-muted">
        Loading…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-panel px-4 py-8 text-center text-xs text-muted">
        No events match the current filter.
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-3 md:grid-cols-2">
      {rows.map((event) => (
        <MobileEventCard
          key={eventReactKey(event)}
          event={event}
          onOpen={() => onSelect(event)}
        />
      ))}
    </div>
  );
}

function MobileEventCard({ event, onOpen }: { event: UsageEventRecord; onOpen: () => void }) {
  const canOpen = Boolean(event.request_id);
  const tier = eventTier(event);
  const activate = () => {
    if (canOpen) onOpen();
  };

  return (
    <article
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? `Open event ${event.request_id}` : undefined}
      onClick={canOpen ? activate : undefined}
      onKeyDown={
        canOpen
          ? (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onOpen();
            }
          : undefined
      }
      className={`min-w-0 overflow-hidden rounded-lg border border-border bg-panel p-3 text-left ${
        canOpen ? "cursor-pointer transition-colors hover:bg-panel2/60 focus:outline-none focus:ring-2 focus:ring-accent" : ""
      }`}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            event.failed ? "bg-danger/10 text-danger" : "bg-success/10 text-success"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${event.failed ? "bg-danger" : "bg-success"}`} />
          {event.failed ? `Failed${event.fail_status_code ? ` ${event.fail_status_code}` : ""}` : "Success"}
        </span>
        {!event.generate && (
          <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[10px] font-medium text-warn">
            Result only
          </span>
        )}
        <time className="shrink-0 font-mono text-[10px] text-muted" dateTime={event.timestamp}>
          {compactTimestamp(event.timestamp)}
        </time>
      </div>

      <div className="mt-2 min-w-0">
        <div className="[overflow-wrap:anywhere] font-mono text-sm font-medium text-ink">
          {event.model || "—"}
        </div>
        {event.alias && event.alias !== event.model && (
          <div className="mt-0.5 truncate text-[11px] text-muted" title={event.alias}>{event.alias}</div>
        )}
        <div className="mt-1 truncate font-mono text-[10px] text-muted" title={event.request_id}>
          {event.request_id || "No request id"}
        </div>
      </div>

      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-t border-border pt-3">
        <MobileEventField
          label="Provider"
          value={eventProvider(event)}
          detail={tier ? `tier ${tier}` : undefined}
        />
        <MobileEventField
          label="Source"
          value={`${event.source_display || event.source || "—"}${event.auth_index ? ` #${event.auth_index}` : ""}`}
          title={event.source}
        />
        <MobileEventField
          label="API"
          value={event.api_group_display || event.api_group_key || "—"}
          detail={event.api_group_display && event.api_group_display !== event.api_group_key ? event.api_group_key : undefined}
          title={event.api_group_key}
        />
        <MobileEventField label="Endpoint" value={event.endpoint || "—"} title={event.endpoint} mono />
      </dl>

      <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border bg-border">
        <MobileMetric
          label="Latency"
          value={formatLatency(event.latency_ms)}
          detail={event.ttft_ms > 0 ? `TTFT ${formatLatency(event.ttft_ms)}` : undefined}
        />
        <MobileMetric label="New" value={formatNumber(event.input_tokens)} />
        <MobileMetric label="Cache read" value={formatNumber(event.cached_tokens)} />
        <MobileMetric label="Cache write" value={formatNumber(event.cache_creation_tokens)} />
        <MobileMetric label="Input" value={formatNumber(eventInputTokens(event))} emphasize />
        <MobileMetric label="Output total" value={formatNumber(event.output_tokens)} />
        <MobileMetric label="Reasoning in output" value={formatNumber(event.reasoning_tokens)} />
        <MobileMetric label="Total" value={formatNumber(event.total_tokens)} emphasize />
        <MobileMetric label="Cost" value={formatCost(event.cost)} />
      </div>
    </article>
  );
}

function MobileEventField({
  label,
  value,
  detail,
  title,
  mono = false,
}: {
  label: string;
  value: string;
  detail?: string;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className={`mt-0.5 truncate text-[11px] text-ink ${mono ? "font-mono" : ""}`} title={title || value}>
        {value}
      </dd>
      {detail && <dd className="truncate font-mono text-[9px] text-muted" title={detail}>{detail}</dd>}
    </div>
  );
}

function MobileMetric({
  label,
  value,
  detail,
  emphasize = false,
}: {
  label: string;
  value: string;
  detail?: string;
  emphasize?: boolean;
}) {
  return (
    <div className="min-w-0 bg-panel2 px-2 py-2 text-right">
      <div className="truncate text-[9px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-xs tabular-nums ${emphasize ? "font-semibold text-ink" : "text-ink"}`}>
        {value}
      </div>
      {detail && <div className="truncate text-[9px] text-muted" title={detail}>{detail}</div>}
    </div>
  );
}

function eventProvider(event: UsageEventRecord): string {
  const values = [...new Set([event.provider, event.executor_type].filter(Boolean))];
  return values.length ? values.join(" · ") : "—";
}

function eventTier(event: UsageEventRecord): string {
  const requestTier = event.service_tier || event.request_service_tier;
  return event.response_service_tier
    ? `${requestTier || "default"} → ${event.response_service_tier}`
    : requestTier;
}

function eventInputTokens(event: UsageEventRecord): number {
  return event.input_tokens + event.cached_tokens + event.cache_creation_tokens;
}

function eventReactKey(event: UsageEventRecord): string {
  if (event.event_key) return event.event_key;
  return [
    event.timestamp,
    event.provider,
    event.executor_type,
    event.model,
    event.source,
    event.auth_index,
    event.request_id,
    event.latency_ms,
    event.input_tokens,
    event.output_tokens,
    event.cached_tokens,
    event.cache_creation_tokens,
    event.failed,
  ].join("\u001f");
}

function compactTimestamp(timestamp: string): string {
  const formatted = formatTimestamp(timestamp);
  return formatted === "—" ? formatted : formatted.replace(/^\d{4}-/, "");
}

function filterFromSearch(sp: URLSearchParams): Filter {
  const requestId = (sp.get("request_id") || "").trim();
  const rangeParam = sp.get("range");
  const fallbackRange = requestId ? "all" : todayFilter.range;
  const range = RANGE_KEYS.includes(rangeParam as RangeKey) ? (rangeParam as RangeKey) : fallbackRange;
  const resultParam = sp.get("result") ?? "";
  const result = RESULT_KEYS.includes(resultParam as ResultFilter) ? (resultParam as ResultFilter) : "";
  return {
    ...todayFilter,
    range,
    start: range === "custom" ? sp.get("start") || undefined : undefined,
    end: range === "custom" ? sp.get("end") || undefined : undefined,
    models: sp.getAll("model"),
    sources: sp.getAll("source"),
    apiKey: sp.getAll("api_key"),
    authIndex: sp.get("auth_index") || "",
    result,
    requestId,
  };
}

function searchFromFilter(filter: Filter): URLSearchParams {
  const sp = new URLSearchParams();
  if (filter.range) sp.set("range", filter.range);
  if (filter.range === "custom") {
    if (filter.start) sp.set("start", filter.start);
    if (filter.end) sp.set("end", filter.end);
  }
  for (const model of filter.models) sp.append("model", model);
  for (const source of filter.sources) sp.append("source", source);
  for (const apiKey of filter.apiKey) sp.append("api_key", apiKey);
  if (filter.authIndex) sp.set("auth_index", filter.authIndex);
  if (filter.result) sp.set("result", filter.result);
  if (filter.requestId) sp.set("request_id", filter.requestId);
  return sp;
}

interface PageProps {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
}

function Pagination(p: PageProps) {
  return (
    <div className="mt-4 flex flex-col gap-3 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
      <div>{p.total.toLocaleString()} events</div>
      <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end sm:gap-3">
        <select
          aria-label="Events per page"
          value={p.pageSize}
          onChange={(e) => p.onPageSizeChange(Number(e.target.value))}
          className="bg-panel2 border border-border rounded px-2 py-1"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
        <button
          onClick={() => p.onPageChange(Math.max(1, p.page - 1))}
          disabled={p.page <= 1}
          className="px-2 py-1 border border-border rounded disabled:opacity-40 hover:text-ink"
        >
          ‹ Prev
        </button>
        <span className="tabular-nums">
          {p.page} / {p.totalPages || 1}
        </span>
        <button
          onClick={() => p.onPageChange(Math.min(p.totalPages || 1, p.page + 1))}
          disabled={p.page >= (p.totalPages || 1)}
          className="px-2 py-1 border border-border rounded disabled:opacity-40 hover:text-ink"
        >
          Next ›
        </button>
      </div>
    </div>
  );
}
