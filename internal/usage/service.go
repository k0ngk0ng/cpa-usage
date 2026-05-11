// Package usage is the application-layer service that fronts storage queries
// for the /usage/* HTTP endpoints. It applies range parsing, redaction, and
// display-name decoration so handlers stay thin.
package usage

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/pricing"
	"github.com/k0ngk0ng/cpa-usage/internal/redact"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// Service fronts storage-layer aggregations and applies redaction/display-name
// decoration before returning to handlers.
type Service struct {
	store    storage.Store
	pricing  *pricing.Service
	displays *DisplayResolver
}

// DisplayResolver maps an api_group_key / source value to a human-friendly
// display string. It's populated from the auth-files + provider-metadata caches.
type DisplayResolver struct {
	store storage.Store
}

// NewDisplayResolver constructs a resolver bound to the storage cache.
func NewDisplayResolver(store storage.Store) *DisplayResolver {
	return &DisplayResolver{store: store}
}

// New constructs the usage Service.
func New(store storage.Store, prices *pricing.Service, displays *DisplayResolver) *Service {
	return &Service{store: store, pricing: prices, displays: displays}
}

// Filter is the parsed filter input shared by all usage endpoints.
type Filter struct {
	Range     string
	Start     time.Time
	End       time.Time
	Models    []string
	Sources   []string
	AuthIndex string
	Result    string
	APIKeys   []string
}

// Page mirrors storage.Page but is exposed at the service layer so handlers
// don't need to import storage directly.
type Page struct {
	Page     int
	PageSize int
}

// ParseFilter normalizes raw query-string values into a Filter.
// `now` is injected so tests can pin the clock.
func ParseFilter(rangeKey string, startStr, endStr string, models, sources, apiKeys []string, authIndex, result string, now time.Time) (Filter, error) {
	f := Filter{
		Range:     strings.TrimSpace(rangeKey),
		AuthIndex: strings.TrimSpace(authIndex),
		Result:    strings.TrimSpace(result),
		Models:    cleanList(models),
		Sources:   cleanList(sources),
		APIKeys:   cleanList(apiKeys),
	}
	if f.Range == "" {
		f.Range = "all"
	}
	switch f.Range {
	case "all":
		// unbounded
	case "today":
		start := startOfDay(now)
		f.Start = start
		f.End = start.Add(24 * time.Hour)
	case "4h":
		f.End = now
		f.Start = now.Add(-4 * time.Hour)
	case "8h":
		f.End = now
		f.Start = now.Add(-8 * time.Hour)
	case "12h":
		f.End = now
		f.Start = now.Add(-12 * time.Hour)
	case "24h":
		f.End = now
		f.Start = now.Add(-24 * time.Hour)
	case "7d":
		end := startOfDay(now).Add(24 * time.Hour)
		f.End = end
		f.Start = end.Add(-7 * 24 * time.Hour)
	case "30d":
		end := startOfDay(now).Add(24 * time.Hour)
		f.End = end
		f.Start = end.Add(-30 * 24 * time.Hour)
	case "custom":
		if strings.TrimSpace(startStr) == "" || strings.TrimSpace(endStr) == "" {
			return f, errors.New("custom range requires start and end")
		}
		s, err := parseTime(startStr)
		if err != nil {
			return f, fmt.Errorf("parse start: %w", err)
		}
		e, err := parseTime(endStr)
		if err != nil {
			return f, fmt.Errorf("parse end: %w", err)
		}
		if !e.After(s) {
			return f, errors.New("end must be after start")
		}
		f.Start = s
		f.End = e
	default:
		return f, fmt.Errorf("unknown range %q", f.Range)
	}
	switch f.Result {
	case "", "success", "failed":
	default:
		return f, fmt.Errorf("unknown result %q", f.Result)
	}
	return f, nil
}

// Overview returns the /usage/overview payload.
func (s *Service) Overview(ctx context.Context, f Filter) (*storage.UsageOverview, error) {
	prices := s.pricing.Snapshot()
	return s.store.BuildUsageOverview(ctx, f.toStorage(), prices)
}

// Events returns paginated raw events with display-name decoration applied.
func (s *Service) Events(ctx context.Context, f Filter, p Page) (*storage.UsageEventsPage, error) {
	prices := s.pricing.Snapshot()
	if p.Page <= 0 {
		p.Page = 1
	}
	if !pageSizeAllowed(p.PageSize) {
		p.PageSize = storage.DefaultPageSize
	}
	page, err := s.store.ListUsageEvents(ctx, f.toStorage(), storage.Page{Page: p.Page, PageSize: p.PageSize}, prices)
	if err != nil {
		return nil, err
	}
	if page == nil {
		return nil, nil
	}
	apiNames, sourceNames := s.lookupCaches(ctx)
	for i := range page.Items {
		ev := &page.Items[i]
		ev.APIGroupDisplay = pickDisplay(apiNames, ev.APIGroupKey)
		ev.SourceDisplay = pickDisplay(sourceNames, ev.Source)
		ev.APIGroupKey = redact.APIAlias(ev.APIGroupKey)
		ev.Source = redact.DisplayName(ev.Source)
	}
	return page, nil
}

// EventFilters returns distinct models + sources + api_keys within the filter window.
func (s *Service) EventFilters(ctx context.Context, f Filter) (*storage.UsageEventFilterOptions, error) {
	opts, err := s.store.ListUsageEventFilterOptions(ctx, f.toStorage())
	if err != nil {
		return nil, err
	}
	rawKeys, err := s.store.ListUsageEventAPIKeys(ctx, f.toStorage())
	if err != nil {
		return nil, err
	}
	apiNames, _ := s.lookupCaches(ctx)
	opts.APIKeyOptions = make([]storage.APIKeyFilterOption, 0, len(rawKeys))
	for _, key := range rawKeys {
		opts.APIKeyOptions = append(opts.APIKeyOptions, storage.APIKeyFilterOption{
			APIKey: key,
			Label:  pickDisplay(apiNames, key),
		})
	}
	return opts, nil
}

// Credentials returns the /usage/credentials payload with display names attached.
func (s *Service) Credentials(ctx context.Context, f Filter) ([]storage.UsageCredentialStat, error) {
	rows, err := s.store.ListUsageCredentialStats(ctx, f.toStorage())
	if err != nil {
		return nil, err
	}
	_, sourceNames := s.lookupCaches(ctx)
	for i := range rows {
		rows[i].SourceDisplay = pickDisplay(sourceNames, rows[i].Source)
		rows[i].Source = redact.DisplayName(rows[i].Source)
	}
	return rows, nil
}

// Analysis returns the /usage/analysis payload with display + redaction applied.
func (s *Service) Analysis(ctx context.Context, f Filter) (*storage.UsageAnalysis, error) {
	prices := s.pricing.Snapshot()
	out, err := s.store.ListUsageAnalysis(ctx, f.toStorage(), prices)
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, nil
	}
	apiNames, _ := s.lookupCaches(ctx)
	decorate := func(rows []storage.UsageAggregationRow) {
		for i := range rows {
			rows[i].APIGroupDisplay = pickDisplay(apiNames, rows[i].APIGroupKey)
			rows[i].APIGroupKey = redact.APIAlias(rows[i].APIGroupKey)
		}
	}
	decorate(out.ByAPI)
	decorate(out.ByModel)
	decorate(out.ByAPIAndModel)
	return out, nil
}

// lookupCaches returns the api_group_key→display and source→display maps.
// Errors are silently swallowed (display falls back to the masked redact form).
//
// apiNames is built from two sources, in priority order:
//  1. api_key aliases (operator-curated friendly labels)
//  2. provider_metadata DisplayName entries (auto-discovered)
//
// The alias pass runs second so it overwrites any provider_metadata entry
// whose lookup_key happens to collide with a raw api_key — operator intent
// always wins.
func (s *Service) lookupCaches(ctx context.Context) (apiNames, sourceNames map[string]string) {
	apiNames = make(map[string]string)
	sourceNames = make(map[string]string)
	if files, err := s.store.ListAuthFiles(ctx); err == nil {
		for _, f := range files {
			label := f.Label
			if label == "" {
				label = f.Name
			}
			if label == "" {
				label = f.Email
			}
			if f.AuthIndex != "" && label != "" {
				sourceNames[f.AuthIndex] = label
				if f.Source != "" {
					sourceNames[f.Source] = label
				}
			}
		}
	}
	if items, err := s.store.ListProviderMetadata(ctx); err == nil {
		for _, m := range items {
			if m.LookupKey == "" || m.DisplayName == "" {
				continue
			}
			apiNames[m.LookupKey] = m.DisplayName
		}
	}
	if aliases, err := s.store.ListAPIKeyAliases(ctx); err == nil {
		for _, a := range aliases {
			if a.APIKey == "" || a.Alias == "" {
				continue
			}
			apiNames[a.APIKey] = a.Alias
		}
	}
	return apiNames, sourceNames
}

func pickDisplay(table map[string]string, key string) string {
	key = strings.TrimSpace(key)
	if key == "" || key == "unknown" {
		return "unknown"
	}
	if v, ok := table[key]; ok && v != "" {
		return v
	}
	return redact.DisplayName(key)
}

func (f Filter) toStorage() storage.UsageFilter {
	return storage.UsageFilter{
		Range:     f.Range,
		Start:     f.Start,
		End:       f.End,
		Models:    f.Models,
		Sources:   f.Sources,
		AuthIndex: f.AuthIndex,
		Result:    f.Result,
		APIKeys:   f.APIKeys,
	}
}

func cleanList(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		out = append(out, s)
	}
	return out
}

func startOfDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

func parseTime(in string) (time.Time, error) {
	in = strings.TrimSpace(in)
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
	} {
		if t, err := time.ParseInLocation(layout, in, time.Local); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized time %q", in)
}

func pageSizeAllowed(size int) bool {
	for _, allowed := range storage.PageSizeAllowed {
		if size == allowed {
			return true
		}
	}
	return false
}
