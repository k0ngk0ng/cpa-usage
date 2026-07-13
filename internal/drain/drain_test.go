package drain

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"github.com/k0ngk0ng/cpa-usage/internal/storage/sqlite"
)

func TestDrainClearsPopErrorAfterSuccessfulPop(t *testing.T) {
	d := &Drain{}
	d.recordError("pop", errors.New("redis down"))

	d.recordPopSuccess(time.Now())

	st := d.Status()
	if st.LastError != "" {
		t.Fatalf("LastError = %q, want cleared", st.LastError)
	}
	if st.BatchesPopped != 1 {
		t.Fatalf("BatchesPopped = %d, want 1", st.BatchesPopped)
	}
}

func TestPersistMessagesKeepsMultipleProviderCallsForRequest(t *testing.T) {
	store, err := sqlite.Open(sqlite.Config{Path: filepath.Join(t.TempDir(), "drain.db")})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	d := &Drain{store: store, logger: logrus.New(), cfg: Config{ErrorBackoff: time.Millisecond}}
	messages := []string{
		`{"timestamp":"2026-07-13T00:00:00Z","provider":"codex","model":"gpt-5","request_id":"shared","tokens":{"input_tokens":10}}`,
		`{"timestamp":"2026-07-13T00:00:00Z","provider":"codex","model":"gpt-image-2","request_id":"shared","tokens":{"input_tokens":20}}`,
	}
	if !d.persistMessages(context.Background(), messages) {
		t.Fatal("persistMessages returned false")
	}
	page, err := store.ListUsageEvents(context.Background(), storage.UsageFilter{RequestID: "shared"}, storage.Page{Page: 1, PageSize: 20}, nil)
	if err != nil {
		t.Fatalf("ListUsageEvents: %v", err)
	}
	if page.Total != 2 {
		t.Fatalf("stored calls = %d, want 2", page.Total)
	}
}

func TestDrainDoesNotClearInsertErrorAfterOnlyPop(t *testing.T) {
	d := &Drain{}
	d.recordError("insert", errors.New("sqlite locked"))

	d.recordPopSuccess(time.Now())

	st := d.Status()
	if st.LastError != "sqlite locked" {
		t.Fatalf("LastError = %q, want insert error retained", st.LastError)
	}
}

func TestDrainClearsInsertErrorAfterSuccessfulInsert(t *testing.T) {
	d := &Drain{}
	d.recordError("insert", errors.New("sqlite locked"))

	d.recordInsertSuccess(time.Now(), 3, 2)

	st := d.Status()
	if st.LastError != "" {
		t.Fatalf("LastError = %q, want cleared", st.LastError)
	}
	if st.TotalInserted != 3 || st.TotalDeduped != 2 {
		t.Fatalf("totals = inserted %d deduped %d, want 3/2", st.TotalInserted, st.TotalDeduped)
	}
}
