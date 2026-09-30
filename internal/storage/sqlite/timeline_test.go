package sqlite

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"gorm.io/gorm"
)

func timelineStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(Config{Path: filepath.Join(t.TempDir(), "timeline.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestTimelineCompleteGroupsAndLegacyFallback(t *testing.T) {
	s := timelineStore(t)
	ctx := context.Background()
	start := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	events := []storage.UsageEvent{
		{EventKey: "old-failed", RequestID: "r1", Model: "model-a", Timestamp: start, LatencyMs: 1000, Failed: true, TotalTokens: 10, SessionID: "s1"},
		{EventKey: "new-success", TraceID: "r1", RequestID: "log-r1", ExecutionID: "exec2", SessionID: "s1", Model: "model-b", Timestamp: start.Add(2 * time.Second), LatencyMs: 3000, TotalTokens: 20},
		{EventKey: "same-request-different-trace", TraceID: "other", RequestID: "r1", Timestamp: start.Add(time.Second), LatencyMs: 500},
		{EventKey: "anonymous", Timestamp: start.Add(3 * time.Second), LatencyMs: -100},
		{EventKey: "anonymous-2", Timestamp: start.Add(3 * time.Second)},
	}
	if _, _, err := s.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListUsageTimelines(ctx, storage.UsageFilter{Result: "failed", Models: []string{"model-a"}, Start: start, End: start.Add(time.Second)}, "request", storage.Page{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("filtered groups: %+v", page)
	}
	summary := page.Items[0]
	if summary.Key != "request:r1" || summary.Records != 2 || summary.Failed != 1 || summary.TotalTokens != 30 || summary.ModelCount != 2 || summary.StartedAtMs != start.UnixMilli() || summary.EndedAtMs != start.Add(5*time.Second).UnixMilli() {
		t.Fatalf("clipped/misgrouped summary: %+v", summary)
	}
	detail, err := s.UsageTimelineDetail(ctx, "request:r1", 0, 0, nil)
	if err != nil || len(detail.Items) != 2 {
		t.Fatalf("detail: %+v %v", detail, err)
	}
	page, err = s.ListUsageTimelines(ctx, storage.UsageFilter{TraceID: "r1"}, "request", storage.Page{})
	if err != nil || page.Total != 1 || page.Items[0].Records != 2 {
		t.Fatalf("legacy trace lookup: %+v %v", page, err)
	}
	all, err := s.ListUsageTimelines(ctx, storage.UsageFilter{}, "request", storage.Page{})
	if err != nil || all.Total != 4 {
		t.Fatalf("anonymous records merged: %+v %v", all, err)
	}
	anon, err := s.UsageTimelineDetail(ctx, "event:anonymous", 0, 0, nil)
	if err != nil || anon.Summary.EndedAtMs != anon.Summary.StartedAtMs {
		t.Fatalf("negative latency envelope: %+v %v", anon, err)
	}
}

func TestTimelineSnapshotPagingAndMetadataRoundTrip(t *testing.T) {
	s := timelineStore(t)
	ctx := context.Background()
	start := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	stream := false
	events := make([]storage.UsageEvent, 205)
	for i := range events {
		events[i] = storage.UsageEvent{EventKey: fmt.Sprintf("event-%d", i), TraceID: "trace", ExecutionID: fmt.Sprintf("execution-%d", i), SessionID: "child", ParentSessionID: "parent", NodeKind: "compaction", IsFork: true, IsCompaction: true, Stream: &stream, ResponseModel: "served", Model: "model", Timestamp: start.Add(time.Duration(i) * time.Millisecond), LatencyMs: 1000, InputTokens: 1_000_000, Generate: true}
	}
	if _, _, err := s.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	prices := map[string]storage.ModelPriceSetting{"model": {PromptPricePer1M: 2}}
	first, err := s.UsageTimelineDetail(ctx, "request:trace", 0, 0, prices)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 200 || first.NextCursor == 0 || first.Summary.Records != 205 {
		t.Fatalf("first page: %+v", first.Summary)
	}
	got := first.Items[0]
	if got.TraceID != "trace" || got.ExecutionID != "execution-0" || got.SessionID != "child" || got.ParentSessionID != "parent" || got.NodeKind != "compaction" || !got.IsFork || !got.IsCompaction || got.Stream == nil || *got.Stream || got.ResponseModel != "served" || got.Cost != 2 {
		t.Fatalf("lost metadata: %+v", got)
	}
	// This late arrival predates page one but must be excluded from the snapshot.
	_, _, err = s.InsertUsageEvents(ctx, []storage.UsageEvent{{EventKey: "late", TraceID: "trace", Timestamp: start.Add(-time.Hour)}})
	if err != nil {
		t.Fatal(err)
	}
	next, err := s.UsageTimelineDetail(ctx, "request:trace", first.NextCursor, first.Snapshot, prices)
	if err != nil || len(next.Items) != 5 || next.NextCursor != 0 || next.Summary.Records != 205 {
		t.Fatalf("unstable pagination: %+v %v", next, err)
	}
	seen := map[string]bool{}
	for _, e := range append(first.Items, next.Items...) {
		if seen[e.EventKey] {
			t.Fatalf("duplicate %s", e.EventKey)
		}
		seen[e.EventKey] = true
	}
	fresh, err := s.UsageTimelineDetail(ctx, "request:trace", 0, 0, nil)
	if err != nil || fresh.Summary.Records != 206 {
		t.Fatalf("refresh: %+v %v", fresh, err)
	}
	sessions, err := s.ListUsageTimelines(ctx, storage.UsageFilter{ParentSessionID: "parent"}, "session", storage.Page{})
	if err != nil || sessions.Total != 1 || sessions.Items[0].Key != "session:child" || sessions.Items[0].Records != 205 {
		t.Fatalf("session relationship: %+v %v", sessions, err)
	}
}

func TestTimelineValidationEmptyAndOrdering(t *testing.T) {
	s := timelineStore(t)
	ctx := context.Background()
	empty, err := s.ListUsageTimelines(ctx, storage.UsageFilter{}, "session", storage.Page{})
	if err != nil || empty.Total != 0 || empty.Items == nil {
		t.Fatalf("empty result: %+v %v", empty, err)
	}
	if _, err = s.UsageTimelineDetail(ctx, "request:missing", 0, 0, nil); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("missing: %v", err)
	}
	for _, key := range []string{"", "request:", "bad:abc", "request:x' OR 1=1 --"} {
		_, err = s.UsageTimelineDetail(ctx, key, 0, 0, nil)
		if err == nil {
			t.Errorf("accepted key %q", key)
		}
	}
	if _, err = s.UsageTimelineDetail(ctx, "request:a", 1, 0, nil); err == nil {
		t.Fatal("accepted cursor without snapshot")
	}
	start := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	_, _, err = s.InsertUsageEvents(ctx, []storage.UsageEvent{
		{EventKey: "a1", RequestID: "a", Timestamp: start},
		{EventKey: "b1", RequestID: "b", Timestamp: start.Add(time.Second)},
		{EventKey: "a2", RequestID: "a", Timestamp: start.Add(2 * time.Second)},
	})
	if err != nil {
		t.Fatal(err)
	}
	// A filter selects older activity; expansion must not reorder groups by
	// later records that were outside that filter.
	filtered, err := s.ListUsageTimelines(ctx, storage.UsageFilter{End: start.Add(2 * time.Second)}, "request", storage.Page{Page: 1, PageSize: 20})
	if err != nil || len(filtered.Items) != 2 || filtered.Items[0].Key != "request:b" || filtered.Items[1].Records != 2 {
		t.Fatalf("filtered order: %+v %v", filtered, err)
	}
	for page, want := range []string{"request:a", "request:b"} {
		got, err := s.ListUsageTimelines(ctx, storage.UsageFilter{}, "request", storage.Page{Page: page + 1, PageSize: 1})
		if err != nil || len(got.Items) != 1 || got.Items[0].Key != want {
			t.Fatalf("page %d: %+v %v", page+1, got, err)
		}
	}
}
