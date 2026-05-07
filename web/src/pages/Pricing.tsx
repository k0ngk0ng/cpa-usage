import { FormEvent, useEffect, useState } from "react";
import Table, { Column } from "../components/Table";
import { api, HttpError } from "../api/client";
import { useRefreshTick } from "../lib/refresh";
import { formatTimestamp } from "../lib/utils";
import type { ModelPriceSetting } from "../api/types";

interface Draft {
  model: string;
  prompt_price_per_1m: string;
  completion_price_per_1m: string;
  cache_price_per_1m: string;
}

const emptyDraft: Draft = {
  model: "",
  prompt_price_per_1m: "0",
  completion_price_per_1m: "0",
  cache_price_per_1m: "0",
};

export default function PricingPage() {
  const [items, setItems] = useState<ModelPriceSetting[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const tick = useRefreshTick();

  const reload = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [p, m] = await Promise.all([api.pricing(), api.usedModels()]);
      setItems(p.items || []);
      setModels(m.items || []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, [tick]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!draft.model.trim()) {
      setErr("Model is required.");
      return;
    }
    setSubmitting(true);
    try {
      await api.upsertPricing({
        model: draft.model.trim(),
        prompt_price_per_1m: Number(draft.prompt_price_per_1m) || 0,
        completion_price_per_1m: Number(draft.completion_price_per_1m) || 0,
        cache_price_per_1m: Number(draft.cache_price_per_1m) || 0,
      });
      setDraft(emptyDraft);
      await reload();
    } catch (e) {
      if (e instanceof HttpError) setErr(e.message);
      else setErr("Save failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (model: string) => {
    if (!confirm(`Delete pricing for ${model}?`)) return;
    try {
      await api.deletePricing(model);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const editRow = (row: ModelPriceSetting) => {
    setDraft({
      model: row.Model,
      prompt_price_per_1m: String(row.PromptPricePer1M),
      completion_price_per_1m: String(row.CompletionPricePer1M),
      cache_price_per_1m: String(row.CachePricePer1M),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cols: Column<ModelPriceSetting>[] = [
    { header: "Model", cell: (r) => <span className="font-mono text-xs">{r.Model}</span> },
    { header: "INPUT /1M", align: "right", cell: (r) => `$${r.PromptPricePer1M}` },
    { header: "CACHE /1M", align: "right", cell: (r) => `$${r.CachePricePer1M}` },
    { header: "OUTPUT /1M", align: "right", cell: (r) => `$${r.CompletionPricePer1M}` },
    { header: "Updated", cell: (r) => <span className="text-xs text-muted">{formatTimestamp(r.UpdatedAt)}</span> },
    {
      header: "",
      align: "right",
      cell: (r) => (
        <div className="flex items-center justify-end gap-2">
          <button onClick={() => editRow(r)} className="text-accent hover:underline text-xs">
            Edit
          </button>
          <button onClick={() => remove(r.Model)} className="text-danger hover:underline text-xs">
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="bg-panel border border-border rounded-lg p-4">
        <h2 className="text-sm uppercase tracking-wider text-muted mb-3">Add or update pricing</h2>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <label className="md:col-span-2 text-sm">
            <span className="text-muted text-xs">Model</span>
            <input
              type="text"
              list="model-suggestions"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              className="mt-1 w-full bg-panel2 border border-border rounded px-2 py-1.5 font-mono text-sm"
              required
            />
            <datalist id="model-suggestions">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <NumberField
            label="INPUT /1M"
            value={draft.prompt_price_per_1m}
            onChange={(v) => setDraft({ ...draft, prompt_price_per_1m: v })}
          />
          <NumberField
            label="CACHE /1M"
            value={draft.cache_price_per_1m}
            onChange={(v) => setDraft({ ...draft, cache_price_per_1m: v })}
          />
          <NumberField
            label="OUTPUT /1M"
            value={draft.completion_price_per_1m}
            onChange={(v) => setDraft({ ...draft, completion_price_per_1m: v })}
          />
        </div>
        <div className="flex items-center gap-3 mt-3">
          <button
            type="submit"
            disabled={submitting}
            className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setDraft(emptyDraft)}
            className="text-xs text-muted hover:text-ink"
          >
            Reset
          </button>
          {err && <div className="text-danger text-sm ml-2">{err}</div>}
        </div>
      </form>

      <Table<ModelPriceSetting>
        columns={cols}
        rows={items}
        rowKey={(r) => r.Model}
        loading={loading && items.length === 0}
        empty="No pricing entries yet."
      />
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="text-sm">
      <span className="text-muted text-xs">{label}</span>
      <input
        type="number"
        min="0"
        step="0.0001"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-panel2 border border-border rounded px-2 py-1.5 text-sm tabular-nums"
      />
    </label>
  );
}
