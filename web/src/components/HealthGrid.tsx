import clsx from "clsx";
import type { HealthCell } from "../api/types";
import { formatTimestamp } from "../lib/utils";

interface Props {
  // Outer = days (chronological), inner = 96 cells per day (15-minute spans).
  grid: HealthCell[][];
}

function cellTone(cell: HealthCell): string {
  if (cell.total === 0) return "bg-panel2";
  const failRate = cell.failed / cell.total;
  if (failRate >= 0.5) return "bg-danger/80";
  if (failRate > 0) return "bg-warn/70";
  // success — gradient by volume
  if (cell.total >= 50) return "bg-success";
  if (cell.total >= 10) return "bg-success/70";
  return "bg-success/40";
}

export default function HealthGrid({ grid }: Props) {
  if (!grid || grid.length === 0) {
    return (
      <div className="bg-panel border border-border rounded-lg p-6 text-muted text-sm text-center">
        No health data.
      </div>
    );
  }
  return (
    <div className="bg-panel border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">7-day request health</h3>
        <Legend />
      </div>
      <div className="space-y-1">
        {grid.map((day, di) => (
          <div key={di} className="flex items-center gap-2">
            <div className="w-12 shrink-0 text-[10px] text-muted text-right tabular-nums">
              {dayLabel(day)}
            </div>
            <div className="grid grid-cols-[repeat(96,minmax(0,1fr))] gap-[2px] flex-1">
              {day.map((cell, ci) => (
                <div
                  key={ci}
                  className={clsx("h-3 rounded-[2px]", cellTone(cell))}
                  title={`${formatTimestamp(cell.bucket)} — ${cell.total} requests, ${cell.failed} failed`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function dayLabel(day: HealthCell[]): string {
  if (day.length === 0) return "";
  const d = new Date(day[0].bucket);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function Legend() {
  const items = [
    { tone: "bg-panel2", label: "no traffic" },
    { tone: "bg-success/40", label: "low" },
    { tone: "bg-success", label: "high" },
    { tone: "bg-warn/70", label: "some failures" },
    { tone: "bg-danger/80", label: "many failures" },
  ];
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1">
          <span className={clsx("inline-block w-3 h-3 rounded-sm", i.tone)} />
          <span>{i.label}</span>
        </div>
      ))}
    </div>
  );
}
