import { useEffect, useState } from "react";
import FilterBar from "../components/FilterBar";
import HealthGrid from "../components/HealthGrid";
import MetricCard from "../components/MetricCard";
import SeriesChart from "../components/SeriesChart";
import { api } from "../api/client";
import { todayFilter, useFilter } from "../hooks/useFilter";
import { useRefreshTick } from "../lib/refresh";
import { formatCost, formatNumber, formatTokens, pct } from "../lib/utils";
import type { UsageHealthMatrix, UsageOverview } from "../api/types";

export default function Overview() {
  const { filter, setFilter } = useFilter(todayFilter);
  const [data, setData] = useState<UsageOverview | null>(null);
  const [health, setHealth] = useState<UsageHealthMatrix | null>(null);
  const [healthYear, setHealthYear] = useState<string>("");
  const [selectedDay, setSelectedDay] = useState<string>("");
  const [healthLoading, setHealthLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    setHealthLoading(true);
    setHealthErr(null);
    api
      .health(filter, healthYear || undefined, selectedDay || undefined)
      .then((d) => {
        if (!cancelled) setHealth(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setHealthErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setHealthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    filter.models,
    filter.sources,
    filter.apiKey,
    filter.authIndex,
    filter.result,
    healthYear,
    selectedDay,
    tick,
  ]);

  const summary = data?.summary;
  const useDaily = filter.range === "7d" || filter.range === "30d" || filter.range === "all";
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
        <div className="grid gap-6 xl:grid-cols-2">
          <div>
            <h2 className="text-sm uppercase tracking-wider text-muted mb-2">
              {useDaily ? "Daily requests" : "Hourly requests"}
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
            <h2 className="text-sm uppercase tracking-wider text-muted mb-2">
              {useDaily ? "Daily tokens" : "Hourly tokens"}
            </h2>
            {loading && !data ? (
              <div className="bg-panel border border-border rounded-lg p-8 text-center text-muted text-sm">
                Loading…
              </div>
            ) : (
              <SeriesChart data={series} granularity={useDaily ? "daily" : "hourly"} mode="tokens" />
            )}
          </div>
        </div>

        <div>
          <h2 className="text-sm uppercase tracking-wider text-muted mb-2">Request matrix</h2>
          {healthErr && (
            <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg p-3 text-sm mb-4">
              {healthErr}
            </div>
          )}
          {healthLoading && !health ? (
            <div className="bg-panel border border-border rounded-lg p-8 text-center text-muted text-sm">
              Loading…
            </div>
          ) : health ? (
            <HealthGrid
              health={health}
              filter={filter}
              selectedDay={selectedDay}
              onYearChange={(year) => {
                setHealthYear(year);
                setSelectedDay("");
              }}
              onDaySelect={setSelectedDay}
            />
          ) : (
            <div className="bg-panel border border-border rounded-lg p-6 text-muted text-sm text-center">
              No request matrix data.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
