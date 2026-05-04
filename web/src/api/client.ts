import type {
  AliasesExport,
  AliasesImportResult,
  APIKeyAlias,
  APIKeyOverview,
  AuthFile,
  BackfillResult,
  DrainStatus,
  EventLogResponse,
  Filter,
  ImportSnapshotResult,
  ModelPriceSetting,
  PricingUpsertRequest,
  ProviderMetadata,
  Session,
  UsageAnalysis,
  UsageCredentialStat,
  UsageEventFilterOptions,
  UsageEventsPage,
  UsageOverview,
  VersionInfo,
} from "./types";

// Resolve the API base URL once. The Go renderer substitutes
// `window.__APP_BASE_PATH__` at request time; in dev (vite serve) the literal
// `"__APP_BASE_PATH__"` survives, so we fall back to `/usage`.
function basePath(): string {
  const raw = (typeof window !== "undefined" ? window.__APP_BASE_PATH__ : "") || "";
  if (!raw || raw === "__APP_BASE_PATH__") return "/usage";
  return raw.replace(/\/+$/, "");
}

export function apiBase(): string {
  return basePath() + "/api/v1";
}

export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = apiBase() + path;
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const message =
      (parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText) || `HTTP ${res.status}`;
    throw new HttpError(res.status, message, parsed);
  }
  return parsed as T;
}

function buildQuery(filter: Filter, extra: Record<string, string | number | undefined> = {}): string {
  const sp = new URLSearchParams();
  if (filter.range) sp.set("range", filter.range);
  if (filter.range === "custom") {
    if (filter.start) sp.set("start", filter.start);
    if (filter.end) sp.set("end", filter.end);
  }
  for (const m of filter.models) sp.append("model", m);
  for (const s of filter.sources) sp.append("source", s);
  if (filter.authIndex) sp.set("auth_index", filter.authIndex);
  if (filter.result) sp.set("result", filter.result);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  async session(): Promise<Session> {
    return request<Session>("/auth/session");
  },
  async login(password: string): Promise<{ authenticated: boolean }> {
    return request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },
  async logout(): Promise<void> {
    await request("/auth/logout", { method: "POST" });
  },

  async status(): Promise<DrainStatus> {
    return request<DrainStatus>("/status");
  },
  async sync(): Promise<{ ok: boolean }> {
    return request("/sync", { method: "POST" });
  },
  async version(): Promise<VersionInfo> {
    return request<VersionInfo>("/version");
  },

  async overview(filter: Filter): Promise<UsageOverview> {
    return request<UsageOverview>("/usage/overview" + buildQuery(filter));
  },
  async analysis(filter: Filter): Promise<UsageAnalysis> {
    return request<UsageAnalysis>("/usage/analysis" + buildQuery(filter));
  },
  async events(filter: Filter, page: number, pageSize: number): Promise<UsageEventsPage> {
    return request<UsageEventsPage>(
      "/usage/events" + buildQuery(filter, { page, page_size: pageSize }),
    );
  },
  async eventFilters(filter: Filter): Promise<UsageEventFilterOptions> {
    return request<UsageEventFilterOptions>(
      "/usage/events/filters" + buildQuery(filter),
    );
  },
  async eventLog(requestId: string): Promise<EventLogResponse> {
    try {
      return await request<EventLogResponse>(
        "/usage/events/" + encodeURIComponent(requestId) + "/log",
      );
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        return { found: false };
      }
      throw e;
    }
  },
  eventLogRawURL(requestId: string): string {
    return apiBase() + "/usage/events/" + encodeURIComponent(requestId) + "/log/raw";
  },
  async credentials(filter: Filter): Promise<{ items: UsageCredentialStat[] }> {
    return request<{ items: UsageCredentialStat[] }>(
      "/usage/credentials" + buildQuery(filter),
    );
  },

  async importSnapshot(rawJson: string): Promise<ImportSnapshotResult> {
    return request<ImportSnapshotResult>("/usage/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawJson,
    });
  },

  async backfillRequestIDs(): Promise<BackfillResult> {
    return request<BackfillResult>("/usage/backfill-request-ids", {
      method: "POST",
    });
  },

  async authFiles(): Promise<{ items: AuthFile[] }> {
    return request<{ items: AuthFile[] }>("/auth-files");
  },
  async providerMetadata(): Promise<{ items: ProviderMetadata[] }> {
    return request<{ items: ProviderMetadata[] }>("/provider-metadata");
  },
  async usedModels(): Promise<{ items: string[] }> {
    return request<{ items: string[] }>("/models/used");
  },

  async pricing(): Promise<{ items: ModelPriceSetting[] }> {
    return request<{ items: ModelPriceSetting[] }>("/pricing");
  },
  async upsertPricing(p: PricingUpsertRequest): Promise<{ ok: boolean }> {
    return request("/pricing", {
      method: "PUT",
      body: JSON.stringify(p),
    });
  },
  async deletePricing(model: string): Promise<{ ok: boolean }> {
    return request(
      "/pricing?" + new URLSearchParams({ model }).toString(),
      { method: "DELETE" },
    );
  },

  async aliases(): Promise<{ items: APIKeyOverview[] }> {
    return request<{ items: APIKeyOverview[] }>("/aliases");
  },
  async upsertAlias(api_key: string, alias: string): Promise<{ ok: boolean }> {
    return request("/aliases", {
      method: "PUT",
      body: JSON.stringify({ api_key, alias }),
    });
  },
  async deleteAlias(api_key: string): Promise<{ ok: boolean }> {
    return request(
      "/aliases?" + new URLSearchParams({ api_key }).toString(),
      { method: "DELETE" },
    );
  },
  async exportAliases(): Promise<AliasesExport> {
    return request<AliasesExport>("/aliases/export");
  },
  async importAliases(
    items: APIKeyAlias[],
    mode: "merge" | "replace",
  ): Promise<AliasesImportResult> {
    return request<AliasesImportResult>("/aliases/import", {
      method: "POST",
      body: JSON.stringify({ mode, items }),
    });
  },
};
