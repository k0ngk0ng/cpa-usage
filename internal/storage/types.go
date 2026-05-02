package storage

import "time"

// UsageEvent is one row decoded from the CPA redis usage queue.
type UsageEvent struct {
	EventKey        string    // request_id from CPA payload, used as dedup key
	Timestamp       time.Time
	Provider        string
	Model           string
	APIGroupKey     string // api_key | provider | endpoint | "unknown"
	Source          string
	AuthIndex       string
	AuthType        string
	APIKey          string
	Endpoint        string
	RequestID       string
	LatencyMs       int64
	InputTokens     int64
	OutputTokens   int64
	ReasoningTokens int64
	CachedTokens    int64
	TotalTokens     int64
	Failed          bool
	InsertedAt      time.Time
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
	Model                 string
	PromptPricePer1M      float64
	CompletionPricePer1M  float64
	CachePricePer1M       float64
	UpdatedAt             time.Time
}

// UsageFilter parameterizes all aggregation/listing queries.
type UsageFilter struct {
	Range     string // all | today | 4h | 8h | 12h | 24h | 7d | custom
	Start     time.Time
	End       time.Time
	Models    []string
	Sources   []string
	AuthIndex string
	Result    string // "" | success | failed
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
	EventKey         string    `json:"event_key"`
	Timestamp        time.Time `json:"timestamp"`
	Provider         string    `json:"provider"`
	Model            string    `json:"model"`
	APIGroupKey      string    `json:"api_group_key"`
	APIGroupDisplay  string    `json:"api_group_display"`
	Source           string    `json:"source"`
	SourceDisplay    string    `json:"source_display"`
	AuthIndex        string    `json:"auth_index"`
	AuthType         string    `json:"auth_type"`
	Endpoint         string    `json:"endpoint"`
	RequestID        string    `json:"request_id"`
	LatencyMs        int64     `json:"latency_ms"`
	InputTokens      int64     `json:"input_tokens"`
	OutputTokens     int64     `json:"output_tokens"`
	ReasoningTokens  int64     `json:"reasoning_tokens"`
	CachedTokens     int64     `json:"cached_tokens"`
	TotalTokens      int64     `json:"total_tokens"`
	Failed           bool      `json:"failed"`
	Cost             float64   `json:"cost"`
}

// UsageEventFilterOptions is the facet response for the events listing UI.
type UsageEventFilterOptions struct {
	Models  []string `json:"models"`
	Sources []string `json:"sources"`
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
	APIGroupKey     string  `json:"api_group_key,omitempty"`
	APIGroupDisplay string  `json:"api_group_display,omitempty"`
	Model           string  `json:"model,omitempty"`
	Total           int64   `json:"total"`
	Success         int64   `json:"success"`
	Failed          int64   `json:"failed"`
	InputTokens     int64   `json:"input_tokens"`
	OutputTokens    int64   `json:"output_tokens"`
	ReasoningTokens int64   `json:"reasoning_tokens"`
	CachedTokens    int64   `json:"cached_tokens"`
	TotalTokens     int64   `json:"total_tokens"`
	Cost            float64 `json:"cost"`
}

// UsageOverview is the response of /usage/overview.
type UsageOverview struct {
	Summary      UsageSummary       `json:"summary"`
	HourlySeries []UsageBucket      `json:"hourly_series"`
	DailySeries  []UsageBucket      `json:"daily_series"`
	HealthGrid   [][]HealthCell     `json:"health_grid"`
	GeneratedAt  time.Time          `json:"generated_at"`
}

// UsageSummary is the aggregated totals shown in the overview header.
type UsageSummary struct {
	Total           int64   `json:"total"`
	Success         int64   `json:"success"`
	Failed          int64   `json:"failed"`
	InputTokens     int64   `json:"input_tokens"`
	OutputTokens    int64   `json:"output_tokens"`
	ReasoningTokens int64   `json:"reasoning_tokens"`
	CachedTokens    int64   `json:"cached_tokens"`
	TotalTokens     int64   `json:"total_tokens"`
	Cost            float64 `json:"cost"`
}

// UsageBucket is one bucket on the time series chart.
type UsageBucket struct {
	Bucket          time.Time `json:"bucket"`
	Total           int64     `json:"total"`
	Success         int64     `json:"success"`
	Failed          int64     `json:"failed"`
	InputTokens     int64     `json:"input_tokens"`
	OutputTokens    int64     `json:"output_tokens"`
	ReasoningTokens int64     `json:"reasoning_tokens"`
	CachedTokens    int64     `json:"cached_tokens"`
	TotalTokens     int64     `json:"total_tokens"`
	Cost            float64   `json:"cost"`
}

// HealthCell is one cell of the 7-day health heatmap (15-minute spans by default).
type HealthCell struct {
	Bucket  time.Time `json:"bucket"`
	Total   int64     `json:"total"`
	Failed  int64     `json:"failed"`
}

// PageSizeAllowed lists the page sizes the API accepts.
var PageSizeAllowed = []int{20, 50, 100, 500, 1000}

const DefaultPageSize = 100
