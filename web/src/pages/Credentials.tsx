import { useEffect, useState } from "react";
import FilterBar from "../components/FilterBar";
import Table, { Column } from "../components/Table";
import { api } from "../api/client";
import { useFilter } from "../hooks/useFilter";
import { useRefreshTick } from "../lib/refresh";
import { formatNumber, pct } from "../lib/utils";
import type { UsageCredentialStat } from "../api/types";

export default function CredentialsPage() {
  const { filter, setFilter } = useFilter();
  const [rows, setRows] = useState<UsageCredentialStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const tick = useRefreshTick();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .credentials(filter)
      .then((d) => {
        if (!cancelled) setRows(d.items || []);
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
  }, [filter, tick]);

  const cols: Column<UsageCredentialStat>[] = [
    {
      header: "Source",
      cell: (r) => (
        <div>
          <div>{r.source_display || r.source}</div>
          {r.source_display && r.source && r.source_display !== r.source && (
            <div className="text-[11px] text-muted font-mono">{r.source}</div>
          )}
        </div>
      ),
    },
    {
      header: "Auth Index",
      cell: (r) => <span className="font-mono text-xs">{r.auth_index || "—"}</span>,
    },
    { header: "Total", align: "right", cell: (r) => formatNumber(r.total) },
    {
      header: "Success",
      align: "right",
      cell: (r) => <span className="text-success">{formatNumber(r.success)}</span>,
    },
    {
      header: "Failed",
      align: "right",
      cell: (r) => (
        <span className={r.failed > 0 ? "text-danger" : ""}>{formatNumber(r.failed)}</span>
      ),
    },
    {
      header: "Success rate",
      align: "right",
      cell: (r) => pct(r.success, r.total),
    },
  ];

  return (
    <div>
      <FilterBar filter={filter} onChange={setFilter} showResult={false} />
      {err && (
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg p-3 text-sm mb-4">
          {err}
        </div>
      )}
      <Table<UsageCredentialStat>
        columns={cols}
        rows={rows}
        rowKey={(r) => `${r.source}|${r.auth_index}`}
        loading={loading && rows.length === 0}
        empty="No credential traffic in this range."
      />
    </div>
  );
}
