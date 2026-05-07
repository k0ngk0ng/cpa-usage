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
  { key: "7d", label: "7d" },
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
      .eventFilters({ ...filter, models: [], sources: [], apiKey: [], result: "" })
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

  return (
    <div className="bg-panel border border-border rounded-lg p-4 mb-6 space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-muted uppercase tracking-wider mr-1">Range</span>
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => update({ range: p.key })}
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
          <div className="flex items-center gap-2 ml-2">
            <input
              type="datetime-local"
              value={filter.start || ""}
              onChange={(e) => update({ start: e.target.value })}
              className="bg-panel2 border border-border rounded px-2 py-1 text-xs"
            />
            <span className="text-muted text-xs">→</span>
            <input
              type="datetime-local"
              value={filter.end || ""}
              onChange={(e) => update({ end: e.target.value })}
              className="bg-panel2 border border-border rounded px-2 py-1 text-xs"
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
