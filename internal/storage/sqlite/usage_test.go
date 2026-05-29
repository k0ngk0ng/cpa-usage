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
	if got.Alias != event.Alias || got.TTFTMs != event.TTFTMs {
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
	if got.ReasoningEffort != event.ReasoningEffort || got.ServiceTier != event.ServiceTier {
		t.Fatalf("reasoning/service tier = %q/%q", got.ReasoningEffort, got.ServiceTier)
	}
}
