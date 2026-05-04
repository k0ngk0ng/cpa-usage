import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import Table, { Column } from "../components/Table";
import { api, HttpError } from "../api/client";
import { useRefreshTick } from "../lib/refresh";
import { formatNumber, formatTimestamp } from "../lib/utils";
import type {
  AliasesExport,
  AliasesImportResult,
  APIKeyAlias,
  APIKeyOverview,
} from "../api/types";

export default function AliasesPage() {
  const [items, setItems] = useState<APIKeyOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [importResult, setImportResult] = useState<AliasesImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const tick = useRefreshTick();

  const reload = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.aliases();
      setItems(r.items || []);
      setDrafts({});
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, [tick]);

  const draftFor = (row: APIKeyOverview): string =>
    drafts[row.api_key] !== undefined ? drafts[row.api_key] : row.alias;

  const isDirty = (row: APIKeyOverview): boolean =>
    drafts[row.api_key] !== undefined && drafts[row.api_key] !== row.alias;

  const save = async (row: APIKeyOverview) => {
    const next = (drafts[row.api_key] ?? row.alias).trim();
    setSavingKey(row.api_key);
    setErr(null);
    try {
      if (next === "") {
        await api.deleteAlias(row.api_key);
      } else {
        await api.upsertAlias(row.api_key, next);
      }
      await reload();
    } catch (e) {
      if (e instanceof HttpError) setErr(e.message);
      else setErr("Save failed: " + (e as Error).message);
    } finally {
      setSavingKey(null);
    }
  };

  const clearAlias = async (row: APIKeyOverview) => {
    if (!row.alias) return;
    if (!confirm(`Clear alias for ${maskKey(row.api_key)}?`)) return;
    setSavingKey(row.api_key);
    try {
      await api.deleteAlias(row.api_key);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingKey(null);
    }
  };

  const exportNow = async () => {
    setErr(null);
    try {
      const dump = await api.exportAliases();
      const blob = new Blob([JSON.stringify(dump, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `cpa-usage-aliases-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    setImportResult(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<AliasesExport> & {
        items?: APIKeyAlias[];
      };
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      if (importMode === "replace") {
        if (
          !confirm(
            `Replace mode will delete every existing alias and insert ${items.length} from the file. Continue?`,
          )
        ) {
          return;
        }
      }
      const res = await api.importAliases(items, importMode);
      setImportResult(res);
      await reload();
    } catch (e) {
      if (e instanceof HttpError) setErr(e.message);
      else setErr("Import failed: " + (e as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const summary = useMemo(() => {
    let aliased = 0;
    let observed = 0;
    for (const it of items) {
      if (it.alias) aliased++;
      if (it.event_count > 0) observed++;
    }
    return { total: items.length, aliased, observed };
  }, [items]);

  const cols: Column<APIKeyOverview>[] = [
    {
      header: "API key",
      cell: (r) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">
            {revealKey === r.api_key ? r.api_key : maskKey(r.api_key)}
          </span>
          <button
            type="button"
            onClick={() =>
              setRevealKey(revealKey === r.api_key ? null : r.api_key)
            }
            className="text-[10px] text-muted hover:text-ink underline"
            title="Toggle full key"
          >
            {revealKey === r.api_key ? "hide" : "show"}
          </button>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(r.api_key)}
            className="text-[10px] text-muted hover:text-ink underline"
            title="Copy to clipboard"
          >
            copy
          </button>
        </div>
      ),
    },
    {
      header: "Alias",
      cell: (r) => (
        <input
          type="text"
          value={draftFor(r)}
          onChange={(e) =>
            setDrafts({ ...drafts, [r.api_key]: e.target.value })
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save(r);
            }
          }}
          placeholder="(no alias)"
          className="w-full bg-panel2 border border-border rounded px-2 py-1 text-xs"
        />
      ),
    },
    {
      header: "Events",
      align: "right",
      cell: (r) => formatNumber(r.event_count),
    },
    {
      header: "Updated",
      cell: (r) => (
        <span className="text-xs text-muted">
          {r.alias_updated_at ? formatTimestamp(r.alias_updated_at) : "—"}
        </span>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (r) => (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => save(r)}
            disabled={savingKey === r.api_key || !isDirty(r)}
            className="text-accent hover:underline text-xs disabled:opacity-30 disabled:no-underline"
          >
            {savingKey === r.api_key ? "Saving…" : "Save"}
          </button>
          {r.alias && (
            <button
              type="button"
              onClick={() => clearAlias(r)}
              disabled={savingKey === r.api_key}
              className="text-danger hover:underline text-xs disabled:opacity-30"
            >
              Clear
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <section className="bg-panel border border-border rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm uppercase tracking-wider text-muted">
            API key aliases
          </h2>
          <span className="text-xs text-muted">
            {summary.aliased} of {summary.total} keys named ·{" "}
            {summary.observed} have traffic
          </span>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={importMode}
              onChange={(e) =>
                setImportMode(e.target.value as "merge" | "replace")
              }
              className="bg-panel2 border border-border rounded px-2 py-1 text-xs"
              title="Import mode"
            >
              <option value="merge">merge</option>
              <option value="replace">replace</option>
            </select>
            <label className="px-3 py-1.5 rounded border border-border hover:bg-panel2 hover:text-ink text-xs cursor-pointer">
              Import…
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                onChange={onImportFile}
                className="hidden"
              />
            </label>
            <button
              type="button"
              onClick={exportNow}
              className="px-3 py-1.5 rounded border border-border hover:bg-panel2 hover:text-ink text-xs"
            >
              Export
            </button>
          </div>
        </div>
        <p className="text-xs text-muted leading-relaxed">
          Aliases attach a friendly name to a raw upstream{" "}
          <code className="font-mono">api_key</code>. They show up wherever{" "}
          <code className="font-mono">api_group_display</code> is rendered —
          the Events table, Analysis, etc. The list pre-populates with every{" "}
          <code className="font-mono">api_key</code> observed in events;
          aliases for keys that haven't been used yet are kept as orphan rows
          at the bottom.
        </p>
        {importResult && (
          <div className="text-xs text-success">
            Import {importResult.mode}: applied {importResult.applied} of{" "}
            {importResult.received} entries.
          </div>
        )}
        {err && <div className="text-sm text-danger">{err}</div>}
      </section>

      <Table<APIKeyOverview>
        columns={cols}
        rows={items}
        rowKey={(r) => r.api_key}
        loading={loading && items.length === 0}
        empty="No api_keys observed yet."
      />
    </div>
  );
}

function maskKey(value: string): string {
  const v = (value || "").trim();
  if (v.length <= 8) return "*".repeat(v.length);
  return v.slice(0, 4) + "…" + v.slice(-4);
}
