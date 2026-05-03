import { useEffect, useState } from "react";
import FilterBar from "../components/FilterBar";
import Table, { Column } from "../components/Table";
import EventLogModal from "../components/EventLogModal";
import { api } from "../api/client";
import { useFilter } from "../hooks/useFilter";
import { useRefreshTick } from "../lib/refresh";
import { formatCost, formatLatency, formatNumber, formatTimestamp } from "../lib/utils";
import type { UsageEventRecord, UsageEventsPage } from "../api/types";

const PAGE_SIZES = [20, 50, 100, 500, 1000];

export default function EventsPage() {
  const { filter, setFilter } = useFilter();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [data, setData] = useState<UsageEventsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<UsageEventRecord | null>(null);
  const tick = useRefreshTick();

  // Reset to page 1 when filter changes.
  useEffect(() => {
    setPage(1);
  }, [filter]);

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
    { header: "Cost", align: "right", cellClassName: "whitespace-nowrap", cell: (r) => formatCost(r.cost) },
  ];

  return (
    <div>
      <FilterBar filter={filter} onChange={setFilter} />
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
