package sqlite

import (
	"context"
	"fmt"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"testing"
	"time"
)

func TestSessionLabelsUseOnlyAssociatedLogsAndPreferNamingEvidence(t *testing.T) {
	s := timelineStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	events := []storage.UsageEvent{
		{EventKey: "a", RequestID: "first", SessionID: "s", ParentSessionID: "parent", Timestamp: now},
		{EventKey: "b", RequestID: "second", SessionID: "s", Timestamp: now.Add(time.Second)},
		{EventKey: "c", RequestID: "title", SessionID: "s", Timestamp: now.Add(2 * time.Second)},
		{EventKey: "d", RequestID: "rename", SessionID: "s", Timestamp: now.Add(3 * time.Second)},
		{EventKey: "e", RequestID: "other", SessionID: "other", Timestamp: now.Add(4 * time.Second)},
	}
	if _, _, err := s.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	save := func(id, title, source string) {
		t.Helper()
		if err := s.SaveRequestLabel(ctx, storage.RequestLabel{RequestID: id, Title: title, Source: source, Complete: true}); err != nil {
			t.Fatal(err)
		}
	}
	save("second", "Later preview", "prompt_preview")
	save("first", "First preview", "prompt_preview")
	save("other", "Unrelated title", "generated_title")
	assert := func(want string) {
		t.Helper()
		label, err := s.SessionLabel(ctx, "s")
		if err != nil || label.Title != want {
			t.Fatalf("label: %+v %v want %s", label, err, want)
		}
	}
	assert("First preview")
	save("title", "Captured name", "generated_title")
	assert("Captured name")
	save("rename", "Updated name", "generated_title")
	assert("Updated name")
	if err := s.SaveRequestLabel(ctx, storage.RequestLabel{RequestID: "rename"}); err != nil {
		t.Fatal(err)
	}
	assert("Updated name")
	save("rename", "Do not downgrade", "prompt_preview")
	assert("Updated name")
	for _, id := range []string{"parent", "missing"} {
		label, err := s.SessionLabel(ctx, id)
		if err != nil || label.Title != "" {
			t.Fatalf("inherited child title: %+v %v", label, err)
		}
	}
}
func TestSessionLabelDiscoveryProgressesAndRetriesUnavailableLogs(t *testing.T) {
	s := timelineStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	events := []storage.UsageEvent{}
	for i := 0; i < 30; i++ {
		events = append(events, storage.UsageEvent{EventKey: fmt.Sprint(i), RequestID: fmt.Sprintf("r%02d", i), SessionID: "s", Timestamp: now.Add(time.Duration(i) * time.Second)})
	}
	events = append(events, storage.UsageEvent{EventKey: "retry", RequestID: "r00", SessionID: "s", Timestamp: now})
	if _, _, err := s.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for batch := 0; batch < 4; batch++ {
		ids, err := s.SessionLabelCandidates(ctx, "s")
		if err != nil {
			t.Fatal(err)
		}
		if batch == 0 && (len(ids) != 8 || ids[0] != "r00" || ids[1] != "r01" || ids[2] != "r29") {
			t.Fatalf("candidate sampling: %v", ids)
		}
		for _, id := range ids {
			if seen[id] {
				t.Fatalf("repeated %s", id)
			}
			seen[id] = true
			if err := s.SaveRequestLabel(ctx, storage.RequestLabel{RequestID: id}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if len(seen) != 30 {
		t.Fatalf("did not progress: %d", len(seen))
	}
	ids, err := s.SessionLabelCandidates(ctx, "s")
	if err != nil || len(ids) != 0 {
		t.Fatalf("retry cooldown: %v %v", ids, err)
	}
	if err := s.db.Model(&requestLabelModel{}).Where("request_id = ?", "r00").Update("checked_at", now.Add(-6*time.Minute)).Error; err != nil {
		t.Fatal(err)
	}
	ids, err = s.SessionLabelCandidates(ctx, "s")
	if err != nil || len(ids) != 1 || ids[0] != "r00" {
		t.Fatalf("retry: %v %v", ids, err)
	}
}

func TestSessionLabelCacheFollowsUsageRetention(t *testing.T) {
	s := timelineStore(t)
	s.retentionDays = 1
	ctx := context.Background()
	now := time.Now().UTC()
	if _, _, err := s.InsertUsageEvents(ctx, []storage.UsageEvent{{EventKey: "old", RequestID: "old", SessionID: "s", Timestamp: now.Add(-48 * time.Hour)}, {EventKey: "new", RequestID: "new", SessionID: "s", Timestamp: now}}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"old", "new"} {
		if err := s.SaveRequestLabel(ctx, storage.RequestLabel{RequestID: id, Title: id, Source: "prompt_preview", Complete: true}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Cleanup(ctx, now); err != nil {
		t.Fatal(err)
	}
	var rows []requestLabelModel
	if err := s.db.Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].RequestID != "new" {
		t.Fatalf("retained orphan labels: %+v", rows)
	}
}
