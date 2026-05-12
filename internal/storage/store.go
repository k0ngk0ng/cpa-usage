// Package storage defines the persistence interface used by the rest of the app.
//
// v1 only ships an SQLite implementation under internal/storage/sqlite, but every
// query the API needs is routed through this Store interface so that future
// MySQL / PostgreSQL / ClickHouse backends can be plugged in without touching
// the service or HTTP layers.
package storage

import (
	"context"
	"time"
)

// Store is the database-agnostic persistence interface.
type Store interface {
	// Ingestion
	InsertUsageEvents(ctx context.Context, events []UsageEvent) (inserted int, deduped int, err error)
	LatestUsageEventTimestamp(ctx context.Context) (time.Time, error)

	// Backfill of imported (legacy snapshot) events that lack a request_id.
	// ListImportedEventsMissingRequestID returns event_key + timestamp + model
	// for every row whose event_key starts with "import:" and whose request_id
	// is empty, so callers can match them against CPA per-request log files.
	ListImportedEventsMissingRequestID(ctx context.Context) ([]ImportedEventStub, error)
	UpdateImportedEventLink(ctx context.Context, eventKey, requestID, endpoint string) error

	// Aggregations
	BuildUsageOverview(ctx context.Context, f UsageFilter, prices map[string]ModelPriceSetting) (*UsageOverview, error)
	BuildUsageHealthGrid(ctx context.Context, f UsageFilter, start, end time.Time) ([][]HealthCell, error)
	ListUsageEventMonths(ctx context.Context, f UsageFilter) ([]UsageHealthMonth, error)
	ListUsageEvents(ctx context.Context, f UsageFilter, p Page, prices map[string]ModelPriceSetting) (*UsageEventsPage, error)
	ListUsageEventFilterOptions(ctx context.Context, f UsageFilter) (*UsageEventFilterOptions, error)
	ListUsageEventAPIKeys(ctx context.Context, f UsageFilter) ([]string, error)
	ListUsageCredentialStats(ctx context.Context, f UsageFilter) ([]UsageCredentialStat, error)
	ListUsageAnalysis(ctx context.Context, f UsageFilter, prices map[string]ModelPriceSetting) (*UsageAnalysis, error)

	// Pricing
	ListUsedModels(ctx context.Context) ([]string, error)
	ListPricing(ctx context.Context) ([]ModelPriceSetting, error)
	UpsertPricing(ctx context.Context, p ModelPriceSetting) error
	DeletePricing(ctx context.Context, model string) error

	// API key aliases — operator-friendly labels for raw api_key values.
	// ListAPIKeyOverview joins distinct api_key values from usage_events with
	// their alias (left join) so the management UI can surface keys that have
	// no alias yet. ReplaceAPIKeyAliases is for the import "replace" mode.
	ListAPIKeyAliases(ctx context.Context) ([]APIKeyAlias, error)
	ListAPIKeyOverview(ctx context.Context) ([]APIKeyOverview, error)
	UpsertAPIKeyAlias(ctx context.Context, alias APIKeyAlias) error
	DeleteAPIKeyAlias(ctx context.Context, apiKey string) error
	ReplaceAPIKeyAliases(ctx context.Context, items []APIKeyAlias) error

	// Metadata caches
	ReplaceAuthFiles(ctx context.Context, files []AuthFile) error
	ListAuthFiles(ctx context.Context) ([]AuthFile, error)
	ReplaceProviderMetadata(ctx context.Context, items []ProviderMetadata) error
	ListProviderMetadata(ctx context.Context) ([]ProviderMetadata, error)

	// Maintenance
	Cleanup(ctx context.Context, now time.Time) error
	Close() error
}
