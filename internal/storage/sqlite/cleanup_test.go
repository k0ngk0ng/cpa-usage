package sqlite

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestCleanupDisabledRetainsAllUsageEvents(t *testing.T) {
	store, err := Open(Config{
		Path:          filepath.Join(t.TempDir(), "usage.db"),
		RetentionDays: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	insertCleanupTestEvents(t, store, now)

	if err := store.Cleanup(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	if got := countUsageEvents(t, store); got != 2 {
		t.Fatalf("usage event count = %d, want 2 when retention is disabled", got)
	}
}

func TestCleanupUsesConfiguredRetentionDays(t *testing.T) {
	store, err := Open(Config{
		Path:          filepath.Join(t.TempDir(), "usage.db"),
		RetentionDays: 30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	insertCleanupTestEvents(t, store, now)

	if err := store.Cleanup(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	if got := countUsageEvents(t, store); got != 1 {
		t.Fatalf("usage event count = %d, want 1 after configured cleanup", got)
	}
}

func insertCleanupTestEvents(t *testing.T, store *Store, now time.Time) {
	t.Helper()
	rows := []usageEventModel{
		{EventKey: "old", Timestamp: now.Add(-31 * 24 * time.Hour)},
		{EventKey: "recent", Timestamp: now.Add(-29 * 24 * time.Hour)},
	}
	if err := store.db.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
}

func countUsageEvents(t *testing.T, store *Store) int64 {
	t.Helper()
	var count int64
	if err := store.db.Model(&usageEventModel{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}
