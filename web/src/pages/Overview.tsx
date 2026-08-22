import { useEffect, useMemo, useState } from "react";
import FilterBar from "../components/FilterBar";
import HealthGrid from "../components/HealthGrid";
import MetricCard from "../components/MetricCard";
import SeriesChart, { type SeriesGranularity } from "../components/SeriesChart";
import { api } from "../api/client";
import { todayFilter, useFilter } from "../hooks/useFilter";
import { useRefreshTick } from "../lib/refresh";
import { formatCost, formatNumber, formatTokens, pct } from "../lib/utils";
import type { UsageBucket, UsageHealthMatrix, UsageOverview } from "../api/types";

const GRANULARITIES: { key: SeriesGranularity; label: string }[] = [
  { key: "hourly", label: "Hourly" },
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

function defaultGranularity(range: string): SeriesGranularity {
  if (range === "30d") return "daily";
  if (range === "all") return "weekly";
  if (range === "7d") return "daily";
  return "hourly";
}

function titleFor(g: SeriesGranularity): string {
  return GRANULARITIES.find((x) => x.key === g)?.label ?? "Hourly";
}

function GranularityToggle({
  value,
  onChange,
}: {
  value: SeriesGranularity;
  onChange: (g: SeriesGranularity) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
      {GRANULARITIES.map((g) => {
        const active = g.key === value;
        return (
          <button
            key={g.key}
            type="button"
            onClick={() => onChange(g.key)}
            className={`px-2 py-1 transition-colors ${
              active ? "bg-accent/20 text-accent" : "bg-panel text-muted hover:text-fg"
            }`}
          >
            {g.label}
          </button>
        );
      })}
    </div>
  );
}

function seriesFor(data: UsageOverview | null, g: SeriesGranularity): UsageBucket[] {
  if (!data) return [];
  switch (g) {
    case "monthly":
      return data.monthly_series || [];
    case "weekly":
      return data.weekly_series || [];
    case "daily":
      return data.daily_series || [];
    default:
      return data.hourly_series || [];
  }
}

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
  const suggested = useMemo(() => defaultGranularity(filter.range), [filter.range]);
  const [requestsGranularity, setRequestsGranularity] = useState<SeriesGranularity>(suggested);
  const [tokensGranularity, setTokensGranularity] = useState<SeriesGranularity>(suggested);
  const [requestsGranTouched, setRequestsGranTouched] = useState(false);
  const [tokensGranTouched, setTokensGranTouched] = useState(false);

  useEffect(() => {
    if (!requestsGranTouched) setRequestsGranularity(suggested);
    if (!tokensGranTouched) setTokensGranularity(suggested);
  }, [suggested, requestsGranTouched, tokensGranTouched]);

  const requestsSeries = seriesFor(data, requestsGranularity);
  const tokensSeries = seriesFor(data, tokensGranularity);

  return (
    <div>
      <FilterBar filter={filter} onChange={setFilter} showApiKey />

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
        <MetricCard
          label="Upstream calls"
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
          value={formatTokens(
            (summary?.input_tokens ?? 0) +
              (summary?.cached_tokens ?? 0) +
              (summary?.cache_creation_tokens ?? 0),
          )}
          hint={
            summary
              ? `${formatTokens(summary.input_tokens)} new · ${formatTokens(summary.cached_tokens)} cache read · ${formatTokens(summary.cache_creation_tokens)} cache write`
              : "—"
          }
        />
        <MetricCard
          label="Output"
          value={formatTokens(summary?.output_tokens)}
          hint={
            summary
              ? `${formatTokens(summary.reasoning_tokens)} reasoning included${summary.unclassified_tokens ? ` · ${formatTokens(summary.unclassified_tokens)} unclassified` : ""}`
              : "—"
          }
        />
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
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm uppercase tracking-wider text-muted">
                {titleFor(requestsGranularity)} upstream calls
              </h2>
              <GranularityToggle
                value={requestsGranularity}
                onChange={(g) => {
                  setRequestsGranularity(g);
                  setRequestsGranTouched(true);
                }}
              />
            </div>
            {loading && !data ? (
              <div className="bg-panel border border-border rounded-lg p-8 text-center text-muted text-sm">
                Loading…
              </div>
            ) : (
              <SeriesChart data={requestsSeries} granularity={requestsGranularity} />
            )}
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm uppercase tracking-wider text-muted">
                {titleFor(tokensGranularity)} tokens
              </h2>
              <GranularityToggle
                value={tokensGranularity}
                onChange={(g) => {
                  setTokensGranularity(g);
                  setTokensGranTouched(true);
                }}
              />
            </div>
            {loading && !data ? (
              <div className="bg-panel border border-border rounded-lg p-8 text-center text-muted text-sm">
                Loading…
              </div>
            ) : (
              <SeriesChart data={tokensSeries} granularity={tokensGranularity} mode="tokens" />
            )}
          </div>
        </div>

        <div>
          <h2 className="text-sm uppercase tracking-wider text-muted mb-2">Upstream call matrix</h2>
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
