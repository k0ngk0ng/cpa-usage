import { useEffect, useState } from "react";
import FilterBar from "../components/FilterBar";
import HealthGrid from "../components/HealthGrid";
import MetricCard from "../components/MetricCard";
import SeriesChart from "../components/SeriesChart";
import { api } from "../api/client";
import { todayFilter, useFilter } from "../hooks/useFilter";
import { useRefreshTick } from "../lib/refresh";
import { formatCost, formatNumber, formatTokens, pct } from "../lib/utils";
import type { UsageOverview } from "../api/types";

export default function Overview() {
  const { filter, setFilter } = useFilter(todayFilter);
  const [data, setData] = useState<UsageOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const tick = useRefreshTick();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .overview(filter)
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

  const summary = data?.summary;
  const useDaily = filter.range === "7d" || filter.range === "all";
  const series = useDaily ? data?.daily_series || [] : data?.hourly_series || [];

  return (
    <div>
      <FilterBar filter={filter} onChange={setFilter} showApiKey />

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
        <MetricCard
          label="Total"
          value={formatNumber(summary?.total ?? 0)}
          hint={
            summary && summary.total > 0
              ? `${pct(summary.success, summary.total)} success`
              : "—"
          }
          tone="accent"
        />
        <MetricCard
          label="Success"
          value={formatNumber(summary?.success ?? 0)}
          tone="success"
        />
        <MetricCard
          label="Failed"
          value={formatNumber(summary?.failed ?? 0)}
          hint={summary && summary.total > 0 ? pct(summary.failed, summary.total) : "—"}
          tone={summary && summary.failed > 0 ? "danger" : "default"}
        />
        <MetricCard
          label="Input"
          value={formatTokens((summary?.input_tokens ?? 0) + (summary?.cached_tokens ?? 0))}
          hint={
            summary
              ? `${formatTokens(summary.input_tokens)} new · ${formatTokens(summary.cached_tokens)} cache hit`
              : "—"
          }
        />
        <MetricCard label="Output" value={formatTokens(summary?.output_tokens)} />
        <MetricCard
          label="Cost"
          value={formatCost(summary?.cost ?? 0)}
          hint={summary?.total_tokens ? `${formatTokens(summary.total_tokens)} tokens` : "—"}
        />
      </div>

      {err && (
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg p-3 text-sm mb-4">
          {err}
        </div>
      )}

      <div className="space-y-6">
        <div>
          <h2 className="text-sm uppercase tracking-wider text-muted mb-2">
            {useDaily ? "Daily traffic" : "Hourly traffic"}
          </h2>
          {loading && !data ? (
            <div className="bg-panel border border-border rounded-lg p-8 text-center text-muted text-sm">
              Loading…
            </div>
          ) : (
            <SeriesChart data={series} granularity={useDaily ? "daily" : "hourly"} />
          )}
        </div>

        <div>
          <h2 className="text-sm uppercase tracking-wider text-muted mb-2">7-day health</h2>
          {data && <HealthGrid grid={data.health_grid || []} />}
        </div>
      </div>
    </div>
  );
}
