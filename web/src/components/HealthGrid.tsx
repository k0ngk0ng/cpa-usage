import { Fragment } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import type { Filter, HealthCell } from "../api/types";
import { formatTimestamp } from "../lib/utils";

interface Props {
  // Outer = days (chronological), inner = 96 cells per day (15-minute spans).
  grid: HealthCell[][];
  filter?: Filter;
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

export default function HealthGrid({ grid, filter }: Props) {
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
  const title = `${days.length}-day request health by hour`;

  return (
    <div className="bg-panel border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <Legend />
      </div>
      <div className="overflow-x-auto pb-1">
        <div
          className="inline-grid items-center gap-[2px]"
          style={{ gridTemplateColumns: `2.75rem repeat(${days.length}, 0.75rem)` }}
        >
          <div />
          {days.map((day, di) => (
            <div key={di} className="h-8 text-center text-[9px] leading-tight text-muted tabular-nums">
              {dayLabelVisible(di, days.length) ? (
                <span className="-rotate-45 origin-bottom-left inline-block whitespace-nowrap">
                  {day.label}
                </span>
              ) : null}
            </div>
          ))}
          {Array.from({ length: 24 }, (_, hour) => (
            <Fragment key={hour}>
              <div className="h-3 pr-2 text-right text-[9px] leading-3 text-muted tabular-nums">
                {hourTickLabel(hour)}
              </div>
              {days.map((day, di) => {
                const cell = day.hours[hour];
                const title = `${day.title} ${hourLabel(hour)} — ${cell.total} requests, ${cell.failed} failed${
                  cell.bucket ? ` (${formatTimestamp(cell.bucket)})` : ""
                }`;
                return (
                  <div key={`${di}-${hour}`} className="flex h-3 items-center justify-center">
                    {cell.total > 0 && cell.bucket ? (
                      <Link
                        to={{ pathname: "/events", search: eventSearch(cell, filter) }}
                        className={clsx(
                          "block h-3 w-3 rounded-[2px] transition-shadow hover:ring-1 hover:ring-accent focus:outline-none focus:ring-1 focus:ring-accent",
                          cellTone(cell, maxTotal),
                        )}
                        title={title}
                        aria-label={`Open events for ${title}`}
                      />
                    ) : (
                      <div
                        className={clsx("h-3 w-3 rounded-[2px]", cellTone(cell, maxTotal))}
                        title={title}
                      />
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
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

function weekdayLabel(d: Date): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00-${String((hour + 1) % 24).padStart(2, "0")}:00`;
}

function hourTickLabel(hour: number): string {
  return hour % 4 === 0 ? `${String(hour).padStart(2, "0")}:00` : "";
}

function dayLabelVisible(index: number, total: number): boolean {
  return index === 0 || index === total - 1 || index % 5 === 0;
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
