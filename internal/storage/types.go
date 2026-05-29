package storage

import (
	"encoding/json"
	"time"
)

// UsageEvent is one row decoded from the CPA redis usage queue.
type UsageEvent struct {
	EventKey            string // request_id from CPA payload, used as dedup key
	Timestamp           time.Time
	Provider            string
	Model               string
	Alias               string
	APIGroupKey         string // api_key | provider | endpoint | "unknown"
	Source              string
	AuthIndex           string
	AuthType            string
	APIKey              string
	Endpoint            string
	RequestID           string
	LatencyMs           int64
	TTFTMs              int64
	InputTokens         int64
	OutputTokens        int64
	ReasoningTokens     int64
	CachedTokens        int64
	CacheReadTokens     int64
	CacheCreationTokens int64
	TotalTokens         int64
	Failed              bool
	FailStatusCode      int
	FailBody            string
	ResponseHeaders     string
	ReasoningEffort     string
	ServiceTier         string
	InsertedAt          time.Time
}

// ImportedEventStub is the minimal projection we need to backfill a request
// log link onto a previously imported event: enough to match it against a
// CPA log filename (timestamp), enough to disambiguate when multiple log
// files fall in the time window (model), and the key required to update.
type ImportedEventStub struct {
	EventKey  string
	Timestamp time.Time
	Model     string
}

// AuthFile mirrors the CPA management /auth-files entries that we cache.
type AuthFile struct {
	AuthIndex   string
	Name        string
	Email       string
	Type        string
	Provider    string
	Label       string
	Status      string
	Source      string
	Disabled    bool
	Unavailable bool
	RuntimeOnly bool
}

// ProviderMetadata mirrors a normalized provider key/auth catalog row.
type ProviderMetadata struct {
	LookupKey    string
	ProviderType string
	DisplayName  string
	ProviderKey  string
	MatchKind    string
}

// ModelPriceSetting represents per-model pricing per 1M tokens.
type ModelPriceSetting struct {
	Model                string
	PromptPricePer1M     float64
	CompletionPricePer1M float64
	CachePricePer1M      float64
	UpdatedAt            time.Time
}

// APIKeyAlias maps a raw upstream api_key (e.g. "sk-abc...") to a
// human-friendly label that can be edited in the dashboard and rendered in
// place of the masked key wherever api_group_display is surfaced.
type APIKeyAlias struct {
	APIKey    string    `json:"api_key"`
	Alias     string    `json:"alias"`
	UpdatedAt time.Time `json:"updated_at"`
}

// APIKeyOverview is the row shape of the Aliases management page: every
// distinct api_key observed in usage_events, left-joined with its alias.
// EventCount is included so operators can prioritise the keys that actually
// see traffic. APIKey is the raw value — the alias-management page is
// already auth-gated and the operator needs the full key to edit/import.
type APIKeyOverview struct {
	APIKey         string    `json:"api_key"`
	Alias          string    `json:"alias"`
	EventCount     int64     `json:"event_count"`
	AliasUpdatedAt time.Time `json:"alias_updated_at,omitempty"`
}

// UsageFilter parameterizes all aggregation/listing queries.
type UsageFilter struct {
	Range     string // all | today | 4h | 8h | 12h | 24h | 2d | 3d | 7d | 30d | custom
	Start     time.Time
	End       time.Time
	Models    []string
	Sources   []string
	AuthIndex string
	Result    string // "" | success | failed
	APIKeys   []string
	RequestID string
}

// HasRange reports whether the filter requests a bounded window.
func (f UsageFilter) HasRange() bool { return !f.Start.IsZero() && !f.End.IsZero() }

// Page is shared list pagination input.
type Page struct {
	Page     int
	PageSize int
}

// UsageEventsPage is paginated raw event listing output.
type UsageEventsPage struct {
	Total      int64
	Page       int
	PageSize   int
	TotalPages int
	Items      []UsageEventRecord
}

// UsageEventRecord is a redacted, serializable view of a UsageEvent.
type UsageEventRecord struct {
	EventKey            string          `json:"event_key"`
	Timestamp           time.Time       `json:"timestamp"`
	Provider            string          `json:"provider"`
	Model               string          `json:"model"`
	Alias               string          `json:"alias"`
	APIGroupKey         string          `json:"api_group_key"`
	APIGroupDisplay     string          `json:"api_group_display"`
	Source              string          `json:"source"`
	SourceDisplay       string          `json:"source_display"`
	AuthIndex           string          `json:"auth_index"`
	AuthType            string          `json:"auth_type"`
	Endpoint            string          `json:"endpoint"`
	RequestID           string          `json:"request_id"`
	LatencyMs           int64           `json:"latency_ms"`
	TTFTMs              int64           `json:"ttft_ms"`
	InputTokens         int64           `json:"input_tokens"`
	OutputTokens        int64           `json:"output_tokens"`
	ReasoningTokens     int64           `json:"reasoning_tokens"`
	CachedTokens        int64           `json:"cached_tokens"`
	CacheReadTokens     int64           `json:"cache_read_tokens"`
	CacheCreationTokens int64           `json:"cache_creation_tokens"`
	TotalTokens         int64           `json:"total_tokens"`
	Failed              bool            `json:"failed"`
	FailStatusCode      int             `json:"fail_status_code"`
	FailBody            string          `json:"fail_body"`
	ResponseHeaders     json.RawMessage `json:"response_headers,omitempty"`
	ReasoningEffort     string          `json:"reasoning_effort"`
	ServiceTier         string          `json:"service_tier"`
	Cost                float64         `json:"cost"`
}

// UsageEventFilterOptions is the facet response for the events listing UI.
type UsageEventFilterOptions struct {
	Models        []string             `json:"models"`
	Sources       []string             `json:"sources"`
	APIKeyOptions []APIKeyFilterOption `json:"api_key_options"`
}

// APIKeyFilterOption is a raw api_key paired with its human-friendly display
// name (alias or provider metadata label) for the events filter dropdown.
type APIKeyFilterOption struct {
	APIKey string `json:"api_key"`
	Label  string `json:"label"`
}

// UsageCredentialStat is one row in /usage/credentials.
type UsageCredentialStat struct {
	Source        string `json:"source"`
	SourceDisplay string `json:"source_display"`
	AuthIndex     string `json:"auth_index"`
	Total         int64  `json:"total"`
	Success       int64  `json:"success"`
	Failed        int64  `json:"failed"`
}

// UsageAnalysis is the response shape of /usage/analysis.
type UsageAnalysis struct {
	ByAPI         []UsageAggregationRow `json:"by_api"`
	ByModel       []UsageAggregationRow `json:"by_model"`
	ByAPIAndModel []UsageAggregationRow `json:"by_api_and_model"`
}

// UsageAggregationRow is a single aggregation row used by /usage/analysis.
type UsageAggregationRow struct {
	APIGroupKey         string  `json:"api_group_key,omitempty"`
	APIGroupDisplay     string  `json:"api_group_display,omitempty"`
	Model               string  `json:"model,omitempty"`
	Total               int64   `json:"total"`
	Success             int64   `json:"success"`
	Failed              int64   `json:"failed"`
	InputTokens         int64   `json:"input_tokens"`
	OutputTokens        int64   `json:"output_tokens"`
	ReasoningTokens     int64   `json:"reasoning_tokens"`
	CachedTokens        int64   `json:"cached_tokens"`
	CacheReadTokens     int64   `json:"cache_read_tokens"`
	CacheCreationTokens int64   `json:"cache_creation_tokens"`
	TotalTokens         int64   `json:"total_tokens"`
	Cost                float64 `json:"cost"`
}

// UsageOverview is the response of /usage/overview.
type UsageOverview struct {
	Summary      UsageSummary   `json:"summary"`
	HourlySeries []UsageBucket  `json:"hourly_series"`
	DailySeries  []UsageBucket  `json:"daily_series"`
	HealthGrid   [][]HealthCell `json:"health_grid"`
	GeneratedAt  time.Time      `json:"generated_at"`
}

// UsageHealthYear is one year option available for the request matrix.
type UsageHealthYear struct {
	Year  int   `json:"year"`
	Total int64 `json:"total"`
}

// UsageHealthDay is one day cell in the year-sized request matrix.
type UsageHealthDay struct {
	Date   string    `json:"date"`
	Bucket time.Time `json:"bucket"`
	Total  int64     `json:"total"`
	Failed int64     `json:"failed"`
}

// UsageHealthMatrix is the year-sized request matrix payload plus optional
// selected-day 5-minute detail rows.
type UsageHealthMatrix struct {
	Year        int               `json:"year"`
	Start       time.Time         `json:"start"`
	End         time.Time         `json:"end"`
	Days        []UsageHealthDay  `json:"days"`
	Years       []UsageHealthYear `json:"years"`
	SelectedDay string            `json:"selected_day,omitempty"`
	Detail      [][]HealthCell    `json:"detail,omitempty"`
}

// UsageSummary is the aggregated totals shown in the overview header.
type UsageSummary struct {
	Total               int64   `json:"total"`
	Success             int64   `json:"success"`
	Failed              int64   `json:"failed"`
	InputTokens         int64   `json:"input_tokens"`
	OutputTokens        int64   `json:"output_tokens"`
	ReasoningTokens     int64   `json:"reasoning_tokens"`
	CachedTokens        int64   `json:"cached_tokens"`
	CacheReadTokens     int64   `json:"cache_read_tokens"`
	CacheCreationTokens int64   `json:"cache_creation_tokens"`
	TotalTokens         int64   `json:"total_tokens"`
	Cost                float64 `json:"cost"`
}

// UsageBucket is one bucket on the time series chart.
type UsageBucket struct {
	Bucket              time.Time `json:"bucket"`
	Total               int64     `json:"total"`
	Success             int64     `json:"success"`
	Failed              int64     `json:"failed"`
	InputTokens         int64     `json:"input_tokens"`
	OutputTokens        int64     `json:"output_tokens"`
	ReasoningTokens     int64     `json:"reasoning_tokens"`
	CachedTokens        int64     `json:"cached_tokens"`
	CacheReadTokens     int64     `json:"cache_read_tokens"`
	CacheCreationTokens int64     `json:"cache_creation_tokens"`
	TotalTokens         int64     `json:"total_tokens"`
	Cost                float64   `json:"cost"`
}

// HealthCell is one cell of the range-sized health heatmap (15-minute spans by default).
type HealthCell struct {
	Bucket time.Time `json:"bucket"`
	Total  int64     `json:"total"`
	Failed int64     `json:"failed"`
}

// PageSizeAllowed lists the page sizes the API accepts.
var PageSizeAllowed = []int{20, 50, 100, 500, 1000}

const DefaultPageSize = 100
