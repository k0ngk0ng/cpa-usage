import { Link } from "react-router-dom";
import clsx from "clsx";
import type { Filter, HealthCell, UsageHealthDay, UsageHealthMatrix } from "../api/types";
import { formatTimestamp } from "../lib/utils";

interface Props {
  health: UsageHealthMatrix;
  filter?: Filter;
  selectedDay?: string;
  onYearChange: (year: string) => void;
  onDaySelect: (day: string) => void;
}

interface YearCell {
  key: string;
  day?: UsageHealthDay;
  inYear: boolean;
  future: boolean;
}

function cellTone(total: number, maxTotal: number): string {
  if (total === 0) return "bg-panel2";
  const intensity = maxTotal > 0 ? total / maxTotal : 0;
  if (intensity >= 0.75) return "bg-success";
  if (intensity >= 0.5) return "bg-success/80";
  if (intensity >= 0.25) return "bg-success/60";
  return "bg-success/35";
}

function failureMarker(total: number, failed: number): string {
  if (total === 0 || failed === 0) return "";
  const failRate = failed / total;
  if (failRate >= 0.5) return "ring-1 ring-danger";
  if (failRate >= 0.1) return "ring-1 ring-warn";
  return "ring-1 ring-success/45";
}

export default function HealthGrid({ health, filter, selectedDay, onYearChange, onDaySelect }: Props) {
  const weeks = buildYearWeeks(health.year, health.days || []);
  const maxDayTotal = Math.max(0, ...(health.days || []).map((day) => day.total));
  const selected = health.selected_day || selectedDay || "";
  const years = yearSelectOptions(health.year, health.years || []);

  return (
    <div className="bg-panel border border-border rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-medium">Request matrix</h3>
        <div className="flex flex-wrap items-center gap-3">
          <Legend />
          <select
            value={String(health.year)}
            onChange={(e) => onYearChange(e.target.value)}
            className="bg-panel2 border border-border rounded px-2 py-1 text-xs text-ink"
            title="Request matrix year"
          >
            {years.map((y) => (
              <option key={y.year} value={y.year}>
                {y.year}
                {y.total ? ` (${y.total.toLocaleString()})` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto pb-1">
        <div
          className="inline-grid items-center gap-[2px]"
          style={{ gridTemplateColumns: `3rem repeat(${weeks.length}, 1.25rem)` }}
        >
          <div className="h-4" />
          {monthLabels(weeks).map((label, index) => (
            <div key={index} className="h-4 text-[9px] leading-4 text-muted">
              {label}
            </div>
          ))}
          {weekdayLabels.map((label, dow) => (
            <div key={label} className="contents">
              <div className="h-5 pr-2 text-right text-[9px] leading-5 text-muted tabular-nums">
                {label}
              </div>
              {weeks.map((week, wi) => {
                const cell = week[dow];
                return (
                  <YearDayCell
                    key={`${wi}-${dow}`}
                    cell={cell}
                    maxTotal={maxDayTotal}
                    selected={selected === cell.key}
                    onSelect={onDaySelect}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {selected ? (
        <DayDetail
          day={selected}
          grid={health.detail || []}
          filter={filter}
        />
      ) : (
        <div className="mt-4 border-t border-border pt-3 text-xs text-muted">
          Select a day to inspect 5-minute traffic.
        </div>
      )}
    </div>
  );
}

function YearDayCell({
  cell,
  maxTotal,
  selected,
  onSelect,
}: {
  cell: YearCell;
  maxTotal: number;
  selected: boolean;
  onSelect: (day: string) => void;
}) {
  if (!cell.inYear) {
    return <div className="h-5 w-5" />;
  }
  const day = cell.day;
  const total = day?.total ?? 0;
  const failed = day?.failed ?? 0;
  const title = `${cell.key} — ${total} requests, ${failed} failed`;
  return (
    <button
      type="button"
      disabled={cell.future}
      onClick={() => onSelect(cell.key)}
      className={clsx(
        "h-5 w-5 rounded-[3px] transition-shadow focus:outline-none focus:ring-1 focus:ring-accent",
        cell.future ? "bg-panel2/40 opacity-50" : [cellTone(total, maxTotal), failureMarker(total, failed)],
        !cell.future && "hover:ring-1 hover:ring-accent",
        selected && "ring-1 ring-accent",
      )}
      title={title}
      aria-label={`Inspect ${title}`}
    />
  );
}

function DayDetail({ day, grid, filter }: { day: string; grid: HealthCell[][]; filter?: Filter }) {
  const maxTotal = Math.max(0, ...grid.flatMap((row) => row.map((cell) => cell.total)));
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 className="text-xs font-medium text-muted">{day} 5-minute distribution</h4>
        <span className="text-[11px] text-muted">6 rows x 48 windows</span>
      </div>
      <div className="overflow-x-auto pb-1">
        <div
          className="inline-grid items-center gap-[2px]"
          style={{ gridTemplateColumns: "3.75rem repeat(48, 1.25rem)" }}
        >
          {grid.map((row, ri) => (
            <div key={ri} className="contents">
              <div className="h-5 pr-2 text-right text-[9px] leading-5 text-muted tabular-nums">
                {detailRowLabel(ri)}
              </div>
              {row.map((cell, ci) => {
                const title = `${formatTimestamp(cell.bucket)} — ${cell.total} requests, ${cell.failed} failed`;
                return (
                  <div key={`${ri}-${ci}`} className="flex h-5 items-center justify-center">
                    {cell.total > 0 && cell.bucket ? (
                      <Link
                        to={{ pathname: "/events", search: eventSearch(cell, filter, 5) }}
                        className={clsx(
                          "block h-5 w-5 rounded-[3px] transition-shadow hover:ring-1 hover:ring-accent focus:outline-none focus:ring-1 focus:ring-accent",
                          cellTone(cell.total, maxTotal),
                          failureMarker(cell.total, cell.failed),
                        )}
                        title={title}
                        aria-label={`Open events for ${title}`}
                      />
                    ) : (
                      <div
                        className={clsx("h-5 w-5 rounded-[3px]", cellTone(cell.total, maxTotal), failureMarker(cell.total, cell.failed))}
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

function buildYearWeeks(year: number, days: UsageHealthDay[]): YearCell[][] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);
  const gridStart = addDays(yearStart, -yearStart.getDay());
  const gridEnd = addDays(yearEnd, 6 - yearEnd.getDay());
  const today = startOfLocalDay(new Date());
  const weeks: YearCell[][] = [];

  for (let weekStart = gridStart; weekStart <= gridEnd; weekStart = addDays(weekStart, 7)) {
    const week: YearCell[] = [];
    for (let dow = 0; dow < 7; dow += 1) {
      const date = addDays(weekStart, dow);
      const key = dateKey(date);
      const inYear = date.getFullYear() === year;
      week.push({
        key,
        day: byDate.get(key),
        inYear,
        future: inYear && startOfLocalDay(date).getTime() > today.getTime(),
      });
    }
    weeks.push(week);
  }
  return weeks;
}

function monthLabels(weeks: YearCell[][]): string[] {
  let lastMonth = -1;
  return weeks.map((week) => {
    const first = week.find((cell) => cell.inYear);
    if (!first) return "";
    const d = parseDateKey(first.key);
    const month = d.getMonth();
    if (month === lastMonth) return "";
    lastMonth = month;
    return monthNames[month];
  });
}

function yearSelectOptions(selected: number, years: { year: number; total: number }[]): { year: number; total: number }[] {
  if (years.some((y) => y.year === selected)) return years;
  return [{ year: selected, total: 0 }, ...years].sort((a, b) => b.year - a.year);
}

function eventSearch(cell: HealthCell, filter: Filter | undefined, minutes: number): string {
  const start = new Date(cell.bucket);
  if (Number.isNaN(start.getTime())) return "";
  const end = new Date(start.getTime() + minutes * 60 * 1000);
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

function detailRowLabel(row: number): string {
  return `${String(row * 4).padStart(2, "0")}:00`;
}

function dateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function Legend() {
  const volumeItems = [
    { tone: "bg-panel2", label: "no traffic" },
    { tone: "bg-success/35", label: "low" },
    { tone: "bg-success/60", label: "medium" },
    { tone: "bg-success/80", label: "high" },
    { tone: "bg-success", label: "peak" },
  ];
  const failureItems = [
    { tone: "bg-panel2 ring-1 ring-success/45", label: "<10% failed" },
    { tone: "bg-panel2 ring-1 ring-warn", label: ">=10% failed" },
    { tone: "bg-panel2 ring-1 ring-danger", label: ">=50% failed" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
      {volumeItems.map((i) => (
        <div key={i.label} className="flex items-center gap-1">
          <span className={clsx("inline-block w-3 h-3 rounded-sm", i.tone)} />
          <span>{i.label}</span>
        </div>
      ))}
      <span className="text-border">|</span>
      {failureItems.map((i) => (
        <div key={i.label} className="flex items-center gap-1">
          <span className={clsx("inline-block w-3 h-3 rounded-sm", i.tone)} />
          <span>{i.label}</span>
        </div>
      ))}
    </div>
  );
}
