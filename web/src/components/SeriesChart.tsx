import {
  Area,
  CartesianGrid,
  ComposedChart,
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
  mode?: "requests" | "tokens";
  height?: number;
}

interface AreaSpec {
  key: string;
  label: string;
  color: string;
}

const REQUEST_AREAS: AreaSpec[] = [
  { key: "success", label: "Success", color: "#4ade80" },
  { key: "failed", label: "Failed", color: "#f87171" },
];

const TOKEN_AREAS: AreaSpec[] = [
  { key: "input", label: "Input", color: "#38bdf8" },
  { key: "output", label: "Output", color: "#fb7185" },
];

export default function SeriesChart({ data, granularity, mode = "requests", height = 280 }: Props) {
  const labelFor = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    if (granularity === "daily") {
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const areas = mode === "tokens" ? TOKEN_AREAS : REQUEST_AREAS;
  const series = data.map((d) =>
    mode === "tokens"
      ? {
          bucket: d.bucket,
          label: labelFor(d.bucket),
          input: d.input_tokens + d.cached_tokens,
          output: d.output_tokens + d.reasoning_tokens,
        }
      : {
          bucket: d.bucket,
          label: labelFor(d.bucket),
          success: d.success,
          failed: d.failed,
        },
  );

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
        <ComposedChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            {areas.map((area) => (
              <linearGradient key={area.key} id={gradientID(mode, area.key)} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={area.color} stopOpacity={0.45} />
                <stop offset="95%" stopColor={area.color} stopOpacity={0} />
              </linearGradient>
            ))}
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
            formatter={(value) => formatNumber(Number(value))}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {areas.map((area) => (
            <Area
              key={area.key}
              type="monotone"
              dataKey={area.key}
              name={area.label}
              stroke={area.color}
              fill={`url(#${gradientID(mode, area.key)})`}
              strokeWidth={2}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function gradientID(mode: string, key: string): string {
  return `g-${mode}-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
