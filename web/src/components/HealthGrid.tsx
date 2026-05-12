import { Link } from "react-router-dom";
import clsx from "clsx";
import type { Filter, HealthCell, UsageHealthMonth } from "../api/types";
import { formatTimestamp } from "../lib/utils";

interface Props {
  // Outer = days (chronological), inner = 96 cells per day (15-minute spans).
  grid: HealthCell[][];
  filter?: Filter;
  month?: string;
  months?: UsageHealthMonth[];
  onMonthChange?: (month: string) => void;
}

function cellTone(cell: HealthCell, maxTotal: number): string {
  if (cell.total === 0) return "bg-panel2";
  const failRate = cell.failed / cell.total;
  if (failRate >= 0.5) return "bg-danger/80";
  if (failRate > 0) return "bg-warn/70";
  const intensity = maxTotal > 0 ? cell.total / maxTotal : 0;
  if (intensity >= 0.66) return "bg-success";
  if (intensity >= 0.33) return "bg-success/70";
  return "bg-success/40";
}

export default function HealthGrid({ grid, filter, month, months = [], onMonthChange }: Props) {
  if (!grid || grid.length === 0) {
    return (
      <div className="bg-panel border border-border rounded-lg p-6 text-muted text-sm text-center">
        No health data.
      </div>
    );
  }
  const days = grid.map((day) => ({
    label: dayLabel(day),
    title: dayTitle(day),
    hours: hourlyCells(day),
  }));
  const maxTotal = Math.max(0, ...days.flatMap((day) => day.hours.map((cell) => cell.total)));
  const monthOptions = monthSelectOptions(month, months);

  return (
    <div className="bg-panel border border-border rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-medium">Request matrix</h3>
        <div className="flex flex-wrap items-center gap-3">
          <Legend />
          {onMonthChange && (
            <select
              value={month || ""}
              onChange={(e) => onMonthChange(e.target.value)}
              className="bg-panel2 border border-border rounded px-2 py-1 text-xs text-ink"
              title="Request matrix month"
            >
              {monthOptions.map((m) => (
                <option key={m.month} value={m.month}>
                  {formatMonthLabel(m.month)}
                  {m.total ? ` (${m.total.toLocaleString()})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="overflow-x-auto pb-1">
        <div
          className="inline-grid items-center gap-[2px]"
          style={{ gridTemplateColumns: `3.75rem repeat(${days.length}, 1.25rem)` }}
        >
          <div className="h-6" />
          {days.map((day, di) => (
            <div key={di} className="h-6 text-center text-[9px] leading-6 text-muted tabular-nums">
              <span title={day.title}>{dayOfMonthLabel(day)}</span>
            </div>
          ))}
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} className="contents">
              <div className="h-5 pr-2 text-right text-[9px] leading-5 text-muted tabular-nums">
                {hourTickLabel(hour)}
              </div>
              {days.map((day, di) => {
                const cell = day.hours[hour];
                const title = `${day.title} ${hourLabel(hour)} — ${cell.total} requests, ${cell.failed} failed${
                  cell.bucket ? ` (${formatTimestamp(cell.bucket)})` : ""
                }`;
                return (
                  <div key={`${di}-${hour}`} className="flex h-5 items-center justify-center">
                    {cell.total > 0 && cell.bucket ? (
                      <Link
                        to={{ pathname: "/events", search: eventSearch(cell, filter) }}
                        className={clsx(
                          "block h-5 w-5 rounded-[3px] transition-shadow hover:ring-1 hover:ring-accent focus:outline-none focus:ring-1 focus:ring-accent",
                          cellTone(cell, maxTotal),
                        )}
                        title={title}
                        aria-label={`Open events for ${title}`}
                      />
                    ) : (
                      <div
                        className={clsx("h-5 w-5 rounded-[3px]", cellTone(cell, maxTotal))}
                        title={title}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function monthSelectOptions(selected: string | undefined, months: UsageHealthMonth[]): UsageHealthMonth[] {
  if (!selected) return months;
  if (months.some((m) => m.month === selected)) return months;
  return [{ month: selected, total: 0 }, ...months].sort((a, b) => b.month.localeCompare(a.month));
}

function formatMonthLabel(month: string): string {
  const [year, rawMonth] = month.split("-");
  const index = Number(rawMonth) - 1;
  if (!year || !Number.isInteger(index) || index < 0 || index > 11) return month;
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][index]} ${year}`;
}

function eventSearch(cell: HealthCell, filter?: Filter): string {
  const start = new Date(cell.bucket);
  if (Number.isNaN(start.getTime())) return "";
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const sp = new URLSearchParams();
  sp.set("range", "custom");
  sp.set("start", formatDateTimeParam(start));
  sp.set("end", formatDateTimeParam(end));
  for (const model of filter?.models ?? []) sp.append("model", model);
  for (const source of filter?.sources ?? []) sp.append("source", source);
  for (const key of filter?.apiKey ?? []) sp.append("api_key", key);
  if (filter?.authIndex) sp.set("auth_index", filter.authIndex);
  if (filter?.result) sp.set("result", filter.result);
  return `?${sp.toString()}`;
}

function formatDateTimeParam(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  const second = String(d.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function hourlyCells(day: HealthCell[]): HealthCell[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const cells = day.slice(hour * 4, hour * 4 + 4);
    return {
      bucket: cells[0]?.bucket ?? "",
      total: cells.reduce((sum, cell) => sum + cell.total, 0),
      failed: cells.reduce((sum, cell) => sum + cell.failed, 0),
    };
  });
}

function dayLabel(day: HealthCell[]): string {
  if (day.length === 0) return "";
  const d = new Date(day[0].bucket);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function dayTitle(day: HealthCell[]): string {
  if (day.length === 0) return "";
  const d = new Date(day[0].bucket);
  if (Number.isNaN(d.getTime())) return "";
  return `${weekdayLabel(d)} ${d.getMonth() + 1}/${d.getDate()}`;
}

function dayOfMonthLabel(day: { label: string; title: string; hours: HealthCell[] }): string {
  const first = day.hours[0]?.bucket;
  if (!first) return day.label;
  const d = new Date(first);
  if (Number.isNaN(d.getTime())) return day.label;
  return String(d.getDate());
}

function weekdayLabel(d: Date): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00-${String((hour + 1) % 24).padStart(2, "0")}:00`;
}

function hourTickLabel(hour: number): string {
  return hour % 3 === 0 ? `${String(hour).padStart(2, "0")}:00` : "";
}

function Legend() {
  const items = [
    { tone: "bg-panel2", label: "no traffic" },
    { tone: "bg-success/40", label: "less" },
    { tone: "bg-success/70", label: "more" },
    { tone: "bg-success", label: "most" },
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
