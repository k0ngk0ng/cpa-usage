import { useEffect, useState } from "react";
import clsx from "clsx";
import Table, { Column } from "../components/Table";
import { api } from "../api/client";
import type { AuthFile, ProviderMetadata } from "../api/types";

export default function AuthFilesPage() {
  const [authFiles, setAuthFiles] = useState<AuthFile[]>([]);
  const [providers, setProviders] = useState<ProviderMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const reload = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [a, p] = await Promise.all([api.authFiles(), api.providerMetadata()]);
      setAuthFiles(a.items || []);
      setProviders(p.items || []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const triggerSync = async () => {
    setSyncing(true);
    setErr(null);
    try {
      await api.sync();
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const authCols: Column<AuthFile>[] = [
    { header: "Index", cell: (r) => <span className="font-mono text-xs">{r.AuthIndex}</span> },
    { header: "Name", cell: (r) => r.Name || "—" },
    { header: "Email", cell: (r) => <span className="text-xs">{r.Email || "—"}</span> },
    { header: "Provider", cell: (r) => r.Provider || "—" },
    { header: "Type", cell: (r) => r.Type || "—" },
    { header: "Label", cell: (r) => r.Label || "—" },
    {
      header: "Status",
      cell: (r) => (
        <span
          className={clsx(
            "text-xs",
            r.Disabled ? "text-muted" : r.Unavailable ? "text-warn" : "text-success",
          )}
        >
          {r.Disabled ? "disabled" : r.Unavailable ? "unavailable" : r.Status || "ok"}
        </span>
      ),
    },
    { header: "Source", cell: (r) => <span className="text-xs">{r.Source || "—"}</span> },
  ];

  const providerCols: Column<ProviderMetadata>[] = [
    { header: "Lookup Key", cell: (r) => <span className="font-mono text-xs">{r.LookupKey}</span> },
    { header: "Type", cell: (r) => r.ProviderType || "—" },
    { header: "Display Name", cell: (r) => r.DisplayName || "—" },
    { header: "Provider Key", cell: (r) => <span className="text-xs">{r.ProviderKey || "—"}</span> },
    { header: "Match Kind", cell: (r) => <span className="text-xs">{r.MatchKind || "—"}</span> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Auth files & provider metadata</h1>
          <p className="text-sm text-muted">
            Cached from CPA management API; refreshed every 30s.
          </p>
        </div>
        <button
          onClick={triggerSync}
          disabled={syncing}
          className="bg-accent text-bg px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {err && (
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg p-3 text-sm">
          {err}
        </div>
      )}

      <section>
        <h2 className="text-sm uppercase tracking-wider text-muted mb-2">Auth files</h2>
        <Table<AuthFile>
          columns={authCols}
          rows={authFiles}
          rowKey={(r) => r.AuthIndex || r.Source}
          loading={loading && authFiles.length === 0}
          empty="No auth files cached."
        />
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-muted mb-2">Provider metadata</h2>
        <Table<ProviderMetadata>
          columns={providerCols}
          rows={providers}
          rowKey={(r) => r.LookupKey}
          loading={loading && providers.length === 0}
          empty="No provider metadata cached."
        />
      </section>
    </div>
  );
}
