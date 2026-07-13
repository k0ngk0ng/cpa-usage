import { useEffect, useState } from "react";
import FilterBar from "../components/FilterBar";
import Table, { Column } from "../components/Table";
import { api } from "../api/client";
import { todayFilter, useFilter } from "../hooks/useFilter";
import { useRefreshTick } from "../lib/refresh";
import { formatCost, formatNumber, pct } from "../lib/utils";
import type { UsageAggregationRow, UsageAnalysis } from "../api/types";

const numericColumns = (): Column<UsageAggregationRow>[] => [
  {
    header: "Calls",
    align: "right",
    cell: (r) => formatNumber(r.total),
  },
  {
    header: "Success",
    align: "right",
    cell: (r) => (
      <span className="text-success">{formatNumber(r.success)}</span>
    ),
  },
  {
    header: "Failed",
    align: "right",
    cell: (r) => (
      <span className={r.failed > 0 ? "text-danger" : ""}>{formatNumber(r.failed)}</span>
    ),
  },
  { header: "Success rate", align: "right", cell: (r) => pct(r.success, r.total) },
  { header: "New", align: "right", cell: (r) => formatNumber(r.input_tokens) },
  { header: "Cache Read", align: "right", cell: (r) => formatNumber(r.cached_tokens) },
  { header: "Cache Write", align: "right", cell: (r) => formatNumber(r.cache_creation_tokens) },
  {
    header: "Input",
    align: "right",
    cell: (r) => (
      <span className="font-medium">
        {formatNumber(r.input_tokens + r.cached_tokens + r.cache_creation_tokens)}
      </span>
    ),
  },
  { header: "Output", align: "right", cell: (r) => formatNumber(r.output_tokens) },
  { header: "Reasoning", align: "right", cell: (r) => formatNumber(r.reasoning_tokens) },
  { header: "Cost", align: "right", cell: (r) => formatCost(r.cost) },
];

export default function AnalysisPage() {
  const { filter, setFilter } = useFilter(todayFilter);
  const [data, setData] = useState<UsageAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const tick = useRefreshTick();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .analysis(filter)
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
  }, [filter, tick]);

  const apiCols: Column<UsageAggregationRow>[] = [
    {
      header: "API",
      cell: (r) => (
        <div>
          <div className="font-medium">{r.api_group_display || r.api_group_key || "—"}</div>
          {r.api_group_display && r.api_group_key && r.api_group_display !== r.api_group_key && (
            <div className="text-[11px] text-muted font-mono">{r.api_group_key}</div>
          )}
        </div>
      ),
    },
    ...numericColumns(),
  ];

  const modelCols: Column<UsageAggregationRow>[] = [
    {
      header: "Model",
      cell: (r) => <span className="font-mono text-xs">{r.model || "—"}</span>,
    },
    ...numericColumns(),
  ];

  const apiModelCols: Column<UsageAggregationRow>[] = [
    {
      header: "API",
      cell: (r) => r.api_group_display || r.api_group_key || "—",
    },
    {
      header: "Model",
      cell: (r) => <span className="font-mono text-xs">{r.model || "—"}</span>,
    },
    ...numericColumns(),
  ];

  return (
    <div>
      <FilterBar filter={filter} onChange={setFilter} showApiKey />
      {err && (
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg p-3 text-sm mb-4">
          {err}
        </div>
      )}
      <div className="space-y-8">
        <Section title="By API">
          <Table
            columns={apiCols}
            rows={data?.by_api || []}
            rowKey={(r) => r.api_group_key || "—"}
            loading={loading && !data}
          />
        </Section>
        <Section title="By Model">
          <Table
            columns={modelCols}
            rows={data?.by_model || []}
            rowKey={(r) => r.model || "—"}
            loading={loading && !data}
          />
        </Section>
        <Section title="By API × Model">
          <Table
            columns={apiModelCols}
            rows={data?.by_api_and_model || []}
            rowKey={(r) => `${r.api_group_key || ""}|${r.model || ""}`}
            loading={loading && !data}
          />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-sm uppercase tracking-wider text-muted mb-2">{title}</h2>
      {children}
    </div>
  );
}
