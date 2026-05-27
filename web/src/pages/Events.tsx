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
const RANGE_KEYS: RangeKey[] = ["all", "today", "4h", "8h", "12h", "24h", "2d", "3d", "7d", "30d", "custom"];
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
      header: "Time",
      cellClassName: "whitespace-nowrap",
      cell: (r) => {
        const d = r.timestamp ? new Date(r.timestamp) : null;
        const ok = d && !Number.isNaN(d.getTime());
        const date = ok ? `${String(d!.getMonth() + 1).padStart(2, "0")}-${String(d!.getDate()).padStart(2, "0")}` : "—";
        const time = ok ? `${String(d!.getHours()).padStart(2, "0")}:${String(d!.getMinutes()).padStart(2, "0")}:${String(d!.getSeconds()).padStart(2, "0")}` : "";
        return (
          <div title={ok ? formatTimestamp(r.timestamp) : ""}>
            <div className="text-[10px] text-muted">{date}</div>
            <div className="font-mono">{time}</div>
            {r.request_id && (
              <div className="text-[10px] text-muted font-mono">{r.request_id}</div>
            )}
          </div>
        );
      },
    },
    {
      header: "",
      cellClassName: "whitespace-nowrap w-3",
      cell: (r) => (
        <span
          title={r.failed ? "Failed" : "Success"}
          className={`inline-block w-2 h-2 rounded-full ${r.failed ? "bg-danger" : "bg-success"}`}
        />
      ),
    },
    { header: "Model", cellClassName: "font-mono whitespace-nowrap", cell: (r) => r.model },
    {
      header: "API",
      cellClassName: "max-w-[14rem]",
      cell: (r) => (
        <div className="truncate" title={r.api_group_key}>
          <div className="truncate">{r.api_group_display || r.api_group_key}</div>
          {r.api_group_display && r.api_group_display !== r.api_group_key && (
            <div className="text-[10px] text-muted font-mono truncate">{r.api_group_key}</div>
          )}
        </div>
      ),
    },
    {
      header: "Source",
      sticky: "left",
      cellClassName: "max-w-[12rem]",
      cell: (r) => (
        <div className="truncate" title={r.source}>
          <div className="truncate">{r.source_display || r.source}</div>
          {r.auth_index && <div className="text-[10px] text-muted font-mono">#{r.auth_index}</div>}
        </div>
      ),
    },
    {
      header: "Endpoint",
      cellClassName: "max-w-[12rem]",
      cell: (r) => (
        <span className="block truncate" title={r.endpoint}>
          {r.endpoint}
        </span>
      ),
    },
    { header: "Latency", align: "right", cellClassName: "whitespace-nowrap", cell: (r) => formatLatency(r.latency_ms) },
    { header: "New", align: "right", cellClassName: "whitespace-nowrap", cell: (r) => formatNumber(r.input_tokens) },
    { header: "Cache Hit", align: "right", cellClassName: "whitespace-nowrap", cell: (r) => formatNumber(r.cached_tokens) },
    {
      header: "Input",
      align: "right",
      cellClassName: "whitespace-nowrap font-medium",
      cell: (r) => formatNumber(r.input_tokens + r.cached_tokens),
    },
    { header: "Output", align: "right", cellClassName: "whitespace-nowrap", cell: (r) => formatNumber(r.output_tokens) },
    { header: "Reasoning", align: "right", cellClassName: "whitespace-nowrap", cell: (r) => formatNumber(r.reasoning_tokens) },
    {
      header: "Total",
      align: "right",
      cellClassName: "whitespace-nowrap font-medium",
      cell: (r) => formatNumber(r.total_tokens),
    },
    { header: "Cost", align: "right", cellClassName: "whitespace-nowrap", cell: (r) => formatCost(r.cost) },
  ];

  return (
    <div>
      <FilterBar filter={filter} onChange={applyFilter} showApiKey />
      <form
        onSubmit={handleRequestSearch}
        className="bg-panel border border-border rounded-lg p-3 mb-4 flex flex-wrap items-center gap-2"
      >
        <input
          aria-label="request_id"
          type="search"
          placeholder="request_id"
          value={requestInput}
          onChange={(e) => setRequestInput(e.target.value)}
          className="bg-panel2 border border-border rounded px-2 py-1 text-xs font-mono w-full sm:min-w-[18rem] sm:flex-1 sm:max-w-xl"
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

      <Table<UsageEventRecord>
        columns={cols}
        rows={data?.Items || []}
        rowKey={(r) => r.event_key || r.request_id}
        loading={loading && !data}
        empty="No events match the current filter."
        onRowClick={(r) => r.request_id && setSelected(r)}
      />

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
    <div className="flex items-center justify-between mt-4 text-xs text-muted">
      <div>{p.total.toLocaleString()} events</div>
      <div className="flex items-center gap-3">
        <select
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
