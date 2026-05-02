import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsageBucket } from "../api/types";
import { formatNumber, formatTimestamp } from "../lib/utils";

interface Props {
  data: UsageBucket[];
  granularity: "hourly" | "daily";
  height?: number;
}

export default function SeriesChart({ data, granularity, height = 280 }: Props) {
  const labelFor = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    if (granularity === "daily") {
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const series = data.map((d) => ({
    bucket: d.bucket,
    label: labelFor(d.bucket),
    Success: d.success,
    Failed: d.failed,
  }));

  if (series.length === 0) {
    return (
      <div className="bg-panel border border-border rounded-lg p-8 text-center text-muted text-sm">
        No data in this range.
      </div>
    );
  }

  return (
    <div className="bg-panel border border-border rounded-lg p-4">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="g-success" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#4ade80" stopOpacity={0.45} />
              <stop offset="95%" stopColor="#4ade80" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="g-failed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f87171" stopOpacity={0.5} />
              <stop offset="95%" stopColor="#f87171" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#262b36" strokeDasharray="3 3" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#8a93a3" }} stroke="#262b36" />
          <YAxis
            tick={{ fontSize: 11, fill: "#8a93a3" }}
            stroke="#262b36"
            tickFormatter={(v) => formatNumber(Number(v))}
          />
          <Tooltip
            contentStyle={{
              background: "#13161c",
              border: "1px solid #262b36",
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(_lbl, payload) => {
              const p = payload?.[0]?.payload as { bucket?: string } | undefined;
              return formatTimestamp(p?.bucket);
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area
            type="monotone"
            dataKey="Success"
            stroke="#4ade80"
            fill="url(#g-success)"
            strokeWidth={2}
          />
          <Area
            type="monotone"
            dataKey="Failed"
            stroke="#f87171"
            fill="url(#g-failed)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
