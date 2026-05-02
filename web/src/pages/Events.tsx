import { useEffect, useState } from "react";
import FilterBar from "../components/FilterBar";
import Table, { Column } from "../components/Table";
import { api } from "../api/client";
import { useFilter } from "../hooks/useFilter";
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
  }, [filter, page, pageSize]);

  const cols: Column<UsageEventRecord>[] = [
    { header: "Time", cell: (r) => <span className="font-mono text-xs">{formatTimestamp(r.timestamp)}</span> },
    {
      header: "Result",
      cell: (r) =>
        r.failed ? (
          <span className="text-danger">FAIL</span>
        ) : (
          <span className="text-success">OK</span>
        ),
    },
    { header: "Model", cell: (r) => <span className="font-mono text-xs">{r.model}</span> },
    {
      header: "API",
      cell: (r) => (
        <div>
          <div>{r.api_group_display || r.api_group_key}</div>
          {r.api_group_display && r.api_group_display !== r.api_group_key && (
            <div className="text-[11px] text-muted font-mono">{r.api_group_key}</div>
          )}
        </div>
      ),
    },
    {
      header: "Source",
      cell: (r) => (
        <div>
          <div>{r.source_display || r.source}</div>
          {r.auth_index && <div className="text-[11px] text-muted font-mono">#{r.auth_index}</div>}
        </div>
      ),
    },
    { header: "Endpoint", cell: (r) => <span className="text-xs">{r.endpoint}</span> },
    { header: "Latency", align: "right", cell: (r) => formatLatency(r.latency_ms) },
    { header: "Input", align: "right", cell: (r) => formatNumber(r.input_tokens) },
    { header: "Output", align: "right", cell: (r) => formatNumber(r.output_tokens) },
    { header: "Cached", align: "right", cell: (r) => formatNumber(r.cached_tokens) },
    { header: "Cost", align: "right", cell: (r) => formatCost(r.cost) },
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
