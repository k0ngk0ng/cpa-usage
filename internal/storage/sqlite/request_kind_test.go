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
