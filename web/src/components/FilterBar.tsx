import { useEffect, useState } from "react";
import clsx from "clsx";
import { api } from "../api/client";
import type { Filter, RangeKey, ResultFilter, APIKeyFilterOption } from "../api/types";

const RANGE_PRESETS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "4h", label: "4h" },
  { key: "8h", label: "8h" },
  { key: "12h", label: "12h" },
  { key: "24h", label: "24h" },
  { key: "2d", label: "2d" },
  { key: "3d", label: "3d" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
  { key: "custom", label: "Custom" },
];

interface Props {
  filter: Filter;
  onChange: (next: Filter) => void;
  showResult?: boolean;
  showFacets?: boolean;
  showApiKey?: boolean;
}

export default function FilterBar({
  filter,
  onChange,
  showResult = true,
  showFacets = true,
  showApiKey = false,
}: Props) {
  const [models, setModels] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [apiKeyOptions, setApiKeyOptions] = useState<APIKeyFilterOption[]>([]);

  useEffect(() => {
    if (!showFacets) return;
    let cancelled = false;
    api
      .eventFilters({ ...filter, models: [], sources: [], apiKey: [], result: "", requestId: "" })
      .then((opts) => {
        if (cancelled) return;
        setModels(opts.models || []);
        setSources(opts.sources || []);
        setApiKeyOptions(opts.api_key_options || []);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [filter.range, filter.start, filter.end, filter.authIndex, showFacets]);

  const update = (patch: Partial<Filter>) => onChange({ ...filter, ...patch });
  const updateRange = (range: RangeKey) => {
    if (range !== "custom") {
      update({ range });
      return;
    }
    const defaults = defaultCustomRange();
    update({
      range,
      start: filter.start || defaults.start,
      end: filter.end || defaults.end,
    });
  };

  return (
    <div className="bg-panel border border-border rounded-lg p-4 mb-6 space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-muted uppercase tracking-wider mr-1">Range</span>
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => updateRange(p.key)}
            className={clsx(
              "px-3 py-1 rounded text-xs border transition-colors",
              filter.range === p.key
                ? "bg-accent text-bg border-accent"
                : "bg-panel2 text-muted border-border hover:text-ink",
            )}
          >
            {p.label}
          </button>
        ))}
        {filter.range === "custom" && (
          <div className="flex flex-wrap items-center gap-2 ml-2">
            <DateTimeField
              dateLabel="Start date"
              timeLabel="Start time"
              fallbackTime="00:00"
              value={filter.start}
              onChange={(start) => update({ start })}
            />
            <span className="text-muted text-xs">→</span>
            <DateTimeField
              dateLabel="End date"
              timeLabel="End time"
              fallbackTime="23:59"
              value={filter.end}
              onChange={(end) => update({ end })}
            />
          </div>
        )}
      </div>

      {(showFacets || showResult) && (
        <div className="flex flex-wrap gap-3 items-center">
          {showFacets && (
            <>
              <MultiSelect
                label="Model"
                values={filter.models}
                options={models}
                onChange={(v) => update({ models: v })}
              />
              <MultiSelect
                label="Source"
                values={filter.sources}
                options={sources}
                onChange={(v) => update({ sources: v })}
              />
              {showApiKey && (
                <KeyedMultiSelect
                  label="API Key"
                  values={filter.apiKey}
                  options={apiKeyOptions.map((o) => ({ value: o.api_key, label: o.label }))}
                  onChange={(v) => update({ apiKey: v })}
                />
              )}
              <input
                type="text"
                placeholder="auth_index"
                value={filter.authIndex}
                onChange={(e) => update({ authIndex: e.target.value })}
                className="bg-panel2 border border-border rounded px-2 py-1 text-xs w-32"
              />
            </>
          )}
          {showResult && (
            <select
              value={filter.result}
              onChange={(e) => update({ result: e.target.value as ResultFilter })}
              className="bg-panel2 border border-border rounded px-2 py-1 text-xs"
            >
              <option value="">All results</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
            </select>
          )}
        </div>
      )}
    </div>
  );
}

function DateTimeField({
  dateLabel,
  timeLabel,
  fallbackTime,
  value,
  onChange,
}: {
  dateLabel: string;
  timeLabel: string;
  fallbackTime: string;
  value?: string;
  onChange: (next?: string) => void;
}) {
  const parts = splitDateTime(value);
  const date = parts.date;
  const time = parts.time || (date ? fallbackTime : "");

  return (
    <div className="flex items-center gap-1">
      <input
        aria-label={dateLabel}
        type="date"
        value={date}
        onChange={(e) => {
          const nextDate = e.target.value;
          onChange(nextDate ? joinDateTime(nextDate, parts.time || fallbackTime) : undefined);
        }}
        className="bg-panel2 border border-border rounded px-2 py-1 text-xs w-36"
      />
      <input
        aria-label={timeLabel}
        type="time"
        lang="en-GB"
        step={60}
        value={time}
        onChange={(e) => {
          const nextTime = e.target.value;
          if (!nextTime) {
            onChange(date ? joinDateTime(date, fallbackTime) : undefined);
            return;
          }
          onChange(joinDateTime(date || localDatePart(new Date()), nextTime));
        }}
        className="bg-panel2 border border-border rounded px-2 py-1 text-xs w-24"
      />
    </div>
  );
}

function defaultCustomRange(): { start: string; end: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 0, 0);
  return {
    start: formatLocalDateTime(start),
    end: formatLocalDateTime(end),
  };
}

function splitDateTime(value?: string): { date: string; time: string } {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2}))?/);
  return {
    date: match?.[1] || "",
    time: match?.[2] || "",
  };
}

function joinDateTime(date: string, time: string): string {
  return `${date}T${time}`;
}

function formatLocalDateTime(d: Date): string {
  return `${localDatePart(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function localDatePart(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function MultiSelect({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  options: string[];
  onChange: (v: string[]) => void;
}) {
  const keyed: { value: string; label: string }[] = options.map((opt) => ({ value: opt, label: opt }));
  return <KeyedMultiSelect label={label} values={values} options={keyed} onChange={onChange} />;
}

function KeyedMultiSelect({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  options: { value: string; label: string }[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = values.length === 0 ? `All ${label.toLowerCase()}s` : `${values.length} selected`;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="bg-panel2 border border-border rounded px-2 py-1 text-xs hover:text-ink"
      >
        {label}: {summary}
      </button>
      {open && (
        <div className="absolute z-10 mt-1 max-h-72 w-64 overflow-auto bg-panel2 border border-border rounded shadow-lg p-2 space-y-1">
          <div className="flex gap-2 mb-1">
            <button
              onClick={() => onChange([])}
              className="text-xs text-accent hover:underline"
            >
              Clear
            </button>
            <button
              onClick={() => setOpen(false)}
              className="ml-auto text-xs text-muted hover:text-ink"
            >
              Close
            </button>
          </div>
          {options.length === 0 && <div className="text-xs text-muted">No options</div>}
          {options.map((opt) => {
            const checked = values.includes(opt.value);
            return (
              <label key={opt.value} className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    if (checked) onChange(values.filter((v) => v !== opt.value));
                    else onChange([...values, opt.value]);
                  }}
                />
                <span className="truncate">{opt.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
