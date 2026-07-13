package sqlite

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

func TestInsertAndListUsageEventNewFields(t *testing.T) {
	store, err := Open(Config{Path: filepath.Join(t.TempDir(), "usage.db")})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	event := storage.UsageEvent{
		EventKey:            "req_123",
		Timestamp:           time.Date(2026, 4, 25, 0, 0, 0, 0, time.UTC),
		Provider:            "openai",
		ExecutorType:        "CodexExecutor",
		Model:               "gpt-5.4",
		Alias:               "client-gpt",
		APIGroupKey:         "test-key",
		APIKey:              "test-key",
		RequestID:           "req_123",
		LatencyMs:           1500,
		TTFTMs:              320,
		InputTokens:         10,
		OutputTokens:        20,
		ReasoningTokens:     3,
		CachedTokens:        4,
		CacheReadTokens:     4,
		CacheCreationTokens: 5,
		TotalTokens:         42,
		Failed:              true,
		FailStatusCode:      429,
		FailBody:            "rate limited",
		ResponseHeaders:     `{"Retry-After":["30"]}`,
		ReasoningEffort:     "medium",
		ServiceTier:         "priority",
		RequestServiceTier:  "priority",
		ResponseServiceTier: "default",
	}
	inserted, deduped, err := store.InsertUsageEvents(context.Background(), []storage.UsageEvent{event})
	if err != nil {
		t.Fatalf("InsertUsageEvents: %v", err)
	}
	if inserted != 1 || deduped != 0 {
		t.Fatalf("inserted/deduped = %d/%d, want 1/0", inserted, deduped)
	}

	page, err := store.ListUsageEvents(context.Background(), storage.UsageFilter{}, storage.Page{Page: 1, PageSize: 20}, nil)
	if err != nil {
		t.Fatalf("ListUsageEvents: %v", err)
	}
	if page == nil || len(page.Items) != 1 {
		t.Fatalf("items = %v, want one row", page)
	}
	got := page.Items[0]
	if got.Alias != event.Alias || got.TTFTMs != event.TTFTMs || got.ExecutorType != event.ExecutorType {
		t.Fatalf("alias/ttft = %q/%d, want %q/%d", got.Alias, got.TTFTMs, event.Alias, event.TTFTMs)
	}
	if got.CacheReadTokens != event.CacheReadTokens || got.CacheCreationTokens != event.CacheCreationTokens {
		t.Fatalf("cache split = %d/%d", got.CacheReadTokens, got.CacheCreationTokens)
	}
	if got.FailStatusCode != event.FailStatusCode || got.FailBody != event.FailBody {
		t.Fatalf("fail = %d/%q", got.FailStatusCode, got.FailBody)
	}
	if string(got.ResponseHeaders) != event.ResponseHeaders {
		t.Fatalf("response_headers = %s", got.ResponseHeaders)
	}
	if got.ReasoningEffort != event.ReasoningEffort || got.ServiceTier != event.ServiceTier ||
		got.RequestServiceTier != event.RequestServiceTier || got.ResponseServiceTier != event.ResponseServiceTier {
		t.Fatalf("reasoning/service tiers = %q/%q/%q/%q", got.ReasoningEffort, got.ServiceTier, got.RequestServiceTier, got.ResponseServiceTier)
	}
}

func TestInsertUsageEventsKeepsMultipleRecordsForOneRequest(t *testing.T) {
	store, err := Open(Config{Path: filepath.Join(t.TempDir(), "usage.db")})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	events := []storage.UsageEvent{
		{EventKey: "usage:shared:main", RequestID: "shared", Model: "gpt-5", Timestamp: time.Now()},
		{EventKey: "usage:shared:image", RequestID: "shared", Model: "gpt-image-2", Timestamp: time.Now()},
	}
	inserted, deduped, err := store.InsertUsageEvents(context.Background(), events)
	if err != nil {
		t.Fatalf("InsertUsageEvents: %v", err)
	}
	if inserted != 2 || deduped != 0 {
		t.Fatalf("inserted/deduped = %d/%d, want 2/0", inserted, deduped)
	}
	inserted, deduped, err = store.InsertUsageEvents(context.Background(), events)
	if err != nil {
		t.Fatalf("InsertUsageEvents duplicate: %v", err)
	}
	if inserted != 0 || deduped != 2 {
		t.Fatalf("duplicate inserted/deduped = %d/%d, want 0/2", inserted, deduped)
	}

	page, err := store.ListUsageEvents(context.Background(), storage.UsageFilter{RequestID: "shared"}, storage.Page{Page: 1, PageSize: 20}, nil)
	if err != nil {
		t.Fatalf("ListUsageEvents: %v", err)
	}
	if page.Total != 2 || len(page.Items) != 2 {
		t.Fatalf("page = total %d items %d, want 2/2", page.Total, len(page.Items))
	}
}

func TestComputeCostIncludesCacheWriteWithInputFallback(t *testing.T) {
	prices := map[string]storage.ModelPriceSetting{
		"m": {
			Model:                "m",
			PromptPricePer1M:     2,
			CompletionPricePer1M: 4,
			CachePricePer1M:      1,
		},
	}
	got := computeCost("m", 1_000_000, 1_000_000, 1_000_000, 1_000_000, prices)
	if got != 9 {
		t.Fatalf("cost = %v, want 9", got)
	}

	writePrice := 3.0
	p := prices["m"]
	p.CacheWritePricePer1M = &writePrice
	prices["m"] = p
	got = computeCost("m", 1_000_000, 1_000_000, 1_000_000, 1_000_000, prices)
	if got != 10 {
		t.Fatalf("explicit cache write cost = %v, want 10", got)
	}
}

func TestPricingPersistsOptionalCacheWritePrice(t *testing.T) {
	store, err := Open(Config{Path: filepath.Join(t.TempDir(), "usage.db")})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	writePrice := 3.5
	setting := storage.ModelPriceSetting{
		Model:                "m",
		PromptPricePer1M:     2,
		CompletionPricePer1M: 4,
		CachePricePer1M:      1,
		CacheWritePricePer1M: &writePrice,
	}
	if err := store.UpsertPricing(context.Background(), setting); err != nil {
		t.Fatalf("UpsertPricing: %v", err)
	}
	rows, err := store.ListPricing(context.Background())
	if err != nil {
		t.Fatalf("ListPricing: %v", err)
	}
	if len(rows) != 1 || rows[0].CacheWritePricePer1M == nil || *rows[0].CacheWritePricePer1M != writePrice {
		t.Fatalf("rows = %#v", rows)
	}

	setting.CacheWritePricePer1M = nil
	if err := store.UpsertPricing(context.Background(), setting); err != nil {
		t.Fatalf("UpsertPricing fallback: %v", err)
	}
	rows, err = store.ListPricing(context.Background())
	if err != nil {
		t.Fatalf("ListPricing fallback: %v", err)
	}
	if len(rows) != 1 || rows[0].CacheWritePricePer1M != nil {
		t.Fatalf("fallback rows = %#v", rows)
	}
}

func TestUsageQueriesIncludeCacheWriteCost(t *testing.T) {
	store, err := Open(Config{Path: filepath.Join(t.TempDir(), "usage.db")})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	event := storage.UsageEvent{
		EventKey:            "usage:cost",
		Timestamp:           time.Now().UTC(),
		Model:               "m",
		InputTokens:         1_000_000,
		OutputTokens:        1_000_000,
		CachedTokens:        1_000_000,
		CacheReadTokens:     1_000_000,
		CacheCreationTokens: 1_000_000,
	}
	if _, _, err := store.InsertUsageEvents(context.Background(), []storage.UsageEvent{event}); err != nil {
		t.Fatalf("InsertUsageEvents: %v", err)
	}
	prices := map[string]storage.ModelPriceSetting{
		"m": {Model: "m", PromptPricePer1M: 2, CompletionPricePer1M: 4, CachePricePer1M: 1},
	}

	overview, err := store.BuildUsageOverview(context.Background(), storage.UsageFilter{}, prices)
	if err != nil {
		t.Fatalf("BuildUsageOverview: %v", err)
	}
	if overview.Summary.Cost != 9 {
		t.Fatalf("overview cost = %v, want 9", overview.Summary.Cost)
	}
	analysis, err := store.ListUsageAnalysis(context.Background(), storage.UsageFilter{}, prices)
	if err != nil {
		t.Fatalf("ListUsageAnalysis: %v", err)
	}
	if len(analysis.ByModel) != 1 || analysis.ByModel[0].Cost != 9 {
		t.Fatalf("analysis = %#v", analysis.ByModel)
	}
	page, err := store.ListUsageEvents(context.Background(), storage.UsageFilter{}, storage.Page{Page: 1, PageSize: 20}, prices)
	if err != nil {
		t.Fatalf("ListUsageEvents: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].Cost != 9 {
		t.Fatalf("events = %#v", page.Items)
	}
}
