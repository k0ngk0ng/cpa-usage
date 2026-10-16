package sqlite

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// Failure matrix: cache lost on restart, repeated request IDs merged in usage,
// unknown reread erases positive evidence, unrelated log IDs, orphan retention.
func TestRequestKindsPersistWithoutMergingUsage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kinds.db")
	s, err := Open(Config{Path: path, RetentionDays: 1})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Now().UTC()
	_, _, err = s.InsertUsageEvents(ctx, []storage.UsageEvent{{EventKey: "a", RequestID: "compact", Timestamp: now}, {EventKey: "b", RequestID: "compact", Timestamp: now}, {EventKey: "c", RequestID: "normal", Timestamp: now.Add(-48 * time.Hour)}, {EventKey: "d", RequestID: "unchecked", Timestamp: now}})
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []storage.RequestKind{{RequestID: "compact", Kind: "compact", Complete: true}, {RequestID: "normal", Kind: "normal", Complete: true}, {RequestID: "compact", Kind: "unknown"}} {
		if err = s.SaveRequestKind(ctx, k); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(Config{Path: path, RetentionDays: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	kinds, err := s.RequestKinds(ctx, []string{"compact", "normal", "unchecked", "absent"})
	if err != nil {
		t.Fatal(err)
	}
	if len(kinds) != 3 || kinds["compact"].Kind != "compact" || !kinds["compact"].Complete || kinds["normal"].Kind != "normal" || kinds["unchecked"].CheckedAt.IsZero() == false {
		t.Fatalf("cache: %+v", kinds)
	}
	if countUsageEvents(t, s) != 4 {
		t.Fatal("duplicate request IDs merged")
	}
	if err = s.Cleanup(ctx, now); err != nil {
		t.Fatal(err)
	}
	var n int64
	if err = s.db.Table("request_log_kinds").Count(&n).Error; err != nil || n != 1 {
		t.Fatalf("orphan cache: %d %v", n, err)
	}
}

// Failure cases: pre-upgrade Normal remains definitive, old Unknown cooldown
// blocks rescanning, unavailable rereads resurrect stale Normal, and previously
// captured Compact evidence disappears when its source log is no longer present.
func TestRequestKindOldCacheIsReclassified(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old-kinds.db")
	s, err := Open(Config{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, kind := range []string{"normal", "unknown", "compact", "contains_compact"} {
		_, _, err = s.InsertUsageEvents(ctx, []storage.UsageEvent{{EventKey: kind, RequestID: kind, Timestamp: time.Now()}})
		if err != nil {
			t.Fatal(err)
		}
		// Omit the version column exactly as v0.4.7 did.
		err = s.db.Exec("INSERT INTO request_log_kinds (request_id, kind, complete, checked_at) VALUES (?, ?, ?, ?)", kind, kind, kind != "unknown", time.Now()).Error
		if err != nil {
			t.Fatal(err)
		}
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(Config{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	kinds, err := s.RequestKinds(ctx, []string{"normal", "unknown", "compact", "contains_compact"})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"normal", "unknown"} {
		if k := kinds[id]; k.Kind != "unknown" || k.Complete || !k.CheckedAt.IsZero() {
			t.Fatalf("stale %s: %+v", id, k)
		}
	}
	for _, id := range []string{"compact", "contains_compact"} {
		if k := kinds[id]; k.Kind != id || !k.Complete {
			t.Fatalf("lost positive: %+v", k)
		}
	}
	if err = s.SaveRequestKind(ctx, storage.RequestKind{RequestID: "normal", Kind: "unknown"}); err != nil {
		t.Fatal(err)
	}
	kinds, err = s.RequestKinds(ctx, []string{"normal"})
	if err != nil {
		t.Fatal(err)
	}
	if k := kinds["normal"]; k.Kind != "unknown" || k.Complete || k.CheckedAt.IsZero() {
		t.Fatalf("stale Normal resurrected: %+v", k)
	}
	if err = s.SaveRequestKind(ctx, storage.RequestKind{RequestID: "normal", Kind: "compact", Complete: true}); err != nil {
		t.Fatal(err)
	}
	kinds, err = s.RequestKinds(ctx, []string{"normal"})
	if err != nil {
		t.Fatal(err)
	}
	if k := kinds["normal"]; k.Kind != "compact" || !k.Complete {
		t.Fatalf("new evidence not cached: %+v", k)
	}
}
