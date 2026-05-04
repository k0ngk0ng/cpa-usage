// API types mirror the JSON shapes returned by the Go backend.
//
// IMPORTANT: structs in `internal/storage/types.go` that have NO json tags get
// serialized with Go's default field names (CapitalCase) — e.g. `AuthFile`,
// `ProviderMetadata`, `ModelPriceSetting`. Other types (`UsageEventRecord`,
// `UsageOverview`, etc.) DO have json tags and use snake_case. Keep both
// conventions below straight.

export type RangeKey =
  | "all"
  | "today"
  | "4h"
  | "8h"
  | "12h"
  | "24h"
  | "7d"
  | "custom";

export type ResultFilter = "" | "success" | "failed";

export interface Filter {
  range: RangeKey;
  start?: string;
  end?: string;
  models: string[];
  sources: string[];
  authIndex: string;
  result: ResultFilter;
}

export interface Session {
  authenticated: boolean;
  auth_required: boolean;
}

export interface UsageSummary {
  total: number;
  success: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost: number;
}

export interface UsageBucket {
  bucket: string;
  total: number;
  success: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost: number;
}

export interface HealthCell {
  bucket: string;
  total: number;
  failed: number;
}

export interface UsageOverview {
  summary: UsageSummary;
  hourly_series: UsageBucket[];
  daily_series: UsageBucket[];
  health_grid: HealthCell[][];
  generated_at: string;
}

export interface UsageEventRecord {
  event_key: string;
  timestamp: string;
  provider: string;
  model: string;
  api_group_key: string;
  api_group_display: string;
  source: string;
  source_display: string;
  auth_index: string;
  auth_type: string;
  endpoint: string;
  request_id: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  failed: boolean;
  cost: number;
}

export interface UsageEventsPage {
  Total: number;
  Page: number;
  PageSize: number;
  TotalPages: number;
  Items: UsageEventRecord[];
}

export interface UsageEventFilterOptions {
  models: string[];
  sources: string[];
}

export interface UsageCredentialStat {
  source: string;
  source_display: string;
  auth_index: string;
  total: number;
  success: number;
  failed: number;
}

export interface UsageAggregationRow {
  api_group_key?: string;
  api_group_display?: string;
  model?: string;
  total: number;
  success: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost: number;
}

export interface UsageAnalysis {
  by_api: UsageAggregationRow[];
  by_model: UsageAggregationRow[];
  by_api_and_model: UsageAggregationRow[];
}

// AuthFile / ProviderMetadata / ModelPriceSetting come back with CapitalCase
// keys because the Go structs have no json tags.

export interface AuthFile {
  AuthIndex: string;
  Name: string;
  Email: string;
  Type: string;
  Provider: string;
  Label: string;
  Status: string;
  Source: string;
  Disabled: boolean;
  Unavailable: boolean;
  RuntimeOnly: boolean;
}

export interface ProviderMetadata {
  LookupKey: string;
  ProviderType: string;
  DisplayName: string;
  ProviderKey: string;
  MatchKind: string;
}

export interface ModelPriceSetting {
  Model: string;
  PromptPricePer1M: number;
  CompletionPricePer1M: number;
  CachePricePer1M: number;
  UpdatedAt: string;
}

export interface PricingUpsertRequest {
  model: string;
  prompt_price_per_1m: number;
  completion_price_per_1m: number;
  cache_price_per_1m: number;
}

export interface DrainStatus {
  redis_address: string;
  last_pop_at: string;
  last_inserted_at: string;
  last_error_at: string;
  last_error: string;
  last_metadata_sync_at: string;
  last_metadata_error: string;
  total_inserted: number;
  total_deduped: number;
  total_decode_errors: number;
  batches_popped: number;
}

export interface BuildStamp {
  version: string;
  commit: string;
  build_date: string;
}

export interface VersionInfo {
  cpa_usage: BuildStamp;
  cpa: BuildStamp;
}

export interface APIResponseAttempt {
  index: number;
  timestamp?: string;
  status?: number;
  error?: string;
  headers: Record<string, string>;
  body: string;
  body_truncated: boolean;
}

export interface EventLogEntry {
  file: string;
  info: Record<string, string>;
  headers: Record<string, string>;
  request_body: string;
  request_body_truncated: boolean;
  api_responses: APIResponseAttempt[];
  response_body: string;
  response_body_truncated: boolean;
}

export interface EventLogResponse {
  found: boolean;
  entry?: EventLogEntry;
}

export interface ImportSnapshotResult {
  added: number;
  skipped: number;
  total: number;
  exported_at?: string;
}

export interface BackfillResult {
  total: number;
  matched: number;
  ambiguous: number;
  missing: number;
  logs_indexed: number;
  log_dir: string;
}

export interface APIKeyOverview {
  api_key: string;
  alias: string;
  event_count: number;
  alias_updated_at?: string;
}

export interface APIKeyAlias {
  api_key: string;
  alias: string;
  updated_at?: string;
}

export interface AliasesExport {
  version: number;
  exported_at: string;
  items: APIKeyAlias[];
}

export interface AliasesImportResult {
  mode: "merge" | "replace";
  applied: number;
  received: number;
}
