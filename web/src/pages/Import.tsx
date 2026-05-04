import { ChangeEvent, DragEvent, useRef, useState } from "react";
import { api, HttpError } from "../api/client";
import type { ImportSnapshotResult } from "../api/types";

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [paste, setPaste] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportSnapshotResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const pickFile = (f: File | null) => {
    setFile(f);
    setResult(null);
    setErr(null);
    if (f) setPaste("");
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    pickFile(e.target.files?.[0] ?? null);
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragOver(false);
    pickFile(e.dataTransfer.files?.[0] ?? null);
  };

  const submit = async () => {
    setErr(null);
    setResult(null);
    let raw = paste.trim();
    if (file) {
      try {
        raw = await file.text();
      } catch (e) {
        setErr("Failed to read file: " + (e as Error).message);
        return;
      }
    }
    if (!raw) {
      setErr("Provide a file or paste the snapshot JSON.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.importSnapshot(raw);
      setResult(res);
      setFile(null);
      setPaste("");
      if (fileInput.current) fileInput.current.value = "";
    } catch (e) {
      if (e instanceof HttpError) setErr(e.message);
      else setErr("Import failed: " + (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <section className="bg-panel border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-sm uppercase tracking-wider text-muted">
          Import legacy CPA usage snapshot
        </h2>
        <p className="text-sm text-muted leading-relaxed">
          Migrate stats from an older CPA that exposed{" "}
          <code className="font-mono text-xs bg-panel2 px-1.5 py-0.5 rounded">
            GET /v0/management/usage/export
          </code>
          . Upload that JSON before upgrading CPA — re-uploads are deduped
          by content hash, so it's safe to retry.
        </p>
        <p className="text-xs text-muted">
          The legacy export keeps stats in memory only. Don't restart the old
          CPA before exporting, or details will be lost. Per-request{" "}
          <code className="font-mono">request_id</code>,{" "}
          <code className="font-mono">provider</code>,{" "}
          <code className="font-mono">endpoint</code> are not in the export
          and will be left empty for imported rows.
        </p>
      </section>

      <section className="bg-panel border border-border rounded-lg p-4 space-y-4">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={
            "block border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors " +
            (dragOver
              ? "border-accent bg-panel2"
              : "border-border hover:bg-panel2")
          }
        >
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            onChange={onFileChange}
            className="hidden"
          />
          {file ? (
            <div className="space-y-1">
              <div className="text-sm text-ink font-mono">{file.name}</div>
              <div className="text-xs text-muted">
                {(file.size / 1024).toFixed(1)} KB · click to choose another
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-sm">
                Drop the export JSON here, or click to choose a file
              </div>
              <div className="text-xs text-muted">.json up to 64 MiB</div>
            </div>
          )}
        </label>

        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">
            Or paste JSON directly
          </summary>
          <textarea
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value);
              if (e.target.value && file) pickFile(null);
            }}
            placeholder='{"version":1,"exported_at":"…","usage":{…}}'
            className="mt-2 w-full h-48 bg-panel2 border border-border rounded px-2 py-1.5 font-mono text-xs"
          />
        </details>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={submitting || (!file && !paste.trim())}
            className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
          >
            {submitting ? "Importing…" : "Import"}
          </button>
          {err && <div className="text-danger text-sm">{err}</div>}
        </div>

        {result && (
          <div className="border-t border-border pt-4 text-sm space-y-1">
            <div className="font-medium text-success">Import complete</div>
            <ResultRow label="New rows added" value={result.added} />
            <ResultRow
              label="Already present (skipped)"
              value={result.skipped}
            />
            <ResultRow label="Total parsed" value={result.total} />
            {result.exported_at && (
              <ResultRow
                label="Snapshot exported at"
                value={new Date(result.exported_at).toLocaleString()}
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function ResultRow({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted w-48">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}
