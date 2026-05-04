package usage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// fakeBackfillStore is a minimal in-memory implementation of BackfillStore
// for the test below. Events that have a non-empty RequestID after Backfill
// are considered matched.
type fakeBackfillStore struct {
	stubs   []storage.ImportedEventStub
	matched map[string]struct{ rid, endpoint string }
}

func (s *fakeBackfillStore) ListImportedEventsMissingRequestID(ctx context.Context) ([]storage.ImportedEventStub, error) {
	return s.stubs, nil
}

func (s *fakeBackfillStore) UpdateImportedEventLink(ctx context.Context, eventKey, requestID, endpoint string) error {
	if s.matched == nil {
		s.matched = make(map[string]struct{ rid, endpoint string })
	}
	s.matched[eventKey] = struct{ rid, endpoint string }{requestID, endpoint}
	return nil
}

// TestBackfillStreamingDelay simulates the production scenario: log filenames
// are stamped 30s after the request was received, so a symmetric ±2s window
// would miss every match. The new asymmetric + REQUEST INFO timestamp logic
// should match all three.
func TestBackfillStreamingDelay(t *testing.T) {
	dir := t.TempDir()

	// Three streamed events at 21:00:00, 21:01:00, 21:02:00 in whatever
	// zone the test host is in. Using time.Local keeps the filename ts
	// (parsed via ParseInLocation/time.Local) aligned with the REQUEST
	// INFO timestamp instant, regardless of where CI runs.
	loc := time.Local
	requestTimes := []time.Time{
		time.Date(2026, 5, 3, 21, 0, 0, 0, loc),
		time.Date(2026, 5, 3, 21, 1, 0, 0, loc),
		time.Date(2026, 5, 3, 21, 2, 0, 0, loc),
	}
	requestIDs := []string{"aaa00001", "bbb00002", "ccc00003"}
	for i, rt := range requestTimes {
		// Filename ts = request ts + 30s (response completion).
		fnTS := rt.Add(30 * time.Second).Format("2006-01-02T150405")
		path := filepath.Join(dir, fmt.Sprintf("v1-responses-%s-%s.log", fnTS, requestIDs[i]))
		body := fmt.Sprintf("=== REQUEST INFO ===\nTimestamp: %s\n\n=== HEADERS ===\n", rt.Format(time.RFC3339Nano))
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// Plus one log inside the asymmetric window but with a clearly different
	// REQUEST INFO timestamp — must NOT be matched.
	noiseRT := time.Date(2026, 5, 3, 21, 5, 0, 0, loc)
	noiseFn := noiseRT.Add(20 * time.Second).Format("2006-01-02T150405")
	noisePath := filepath.Join(dir, "v1-responses-"+noiseFn+"-noise111.log")
	if err := os.WriteFile(noisePath, []byte("=== REQUEST INFO ===\nTimestamp: "+noiseRT.Format(time.RFC3339Nano)+"\n=== HEADERS ===\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	store := &fakeBackfillStore{
		stubs: []storage.ImportedEventStub{
			{EventKey: "import:e1", Timestamp: requestTimes[0].UTC(), Model: "gpt-5.5"},
			{EventKey: "import:e2", Timestamp: requestTimes[1].UTC(), Model: "gpt-5.5"},
			{EventKey: "import:e3", Timestamp: requestTimes[2].UTC(), Model: "gpt-5.5"},
		},
	}

	res, err := Backfill(context.Background(), store, dir)
	if err != nil {
		t.Fatalf("Backfill: %v", err)
	}
	if res.Matched != 3 {
		t.Errorf("Matched=%d want 3 (result: %+v)", res.Matched, res)
	}
	if res.Missing != 0 || res.Ambiguous != 0 {
		t.Errorf("expected no missing/ambiguous, got %+v", res)
	}
	for i, ek := range []string{"import:e1", "import:e2", "import:e3"} {
		got, ok := store.matched[ek]
		if !ok {
			t.Errorf("event %s not matched", ek)
			continue
		}
		if got.rid != requestIDs[i] {
			t.Errorf("%s -> rid=%q want %q", ek, got.rid, requestIDs[i])
		}
		if got.endpoint != "/v1/responses" {
			t.Errorf("%s -> endpoint=%q want /v1/responses", ek, got.endpoint)
		}
	}
	// Noise log must remain unclaimed.
	if _, ok := store.matched["noise111"]; ok {
		t.Error("noise log should not be matched")
	}
}

// TestBackfillFallsBackToModelMatch ensures that when REQUEST INFO timestamps
// are missing/unparseable, the older model-disambiguation path still works
// for low-traffic windows.
func TestBackfillFallsBackToModelMatch(t *testing.T) {
	dir := t.TempDir()
	loc := time.Local
	rt := time.Date(2026, 5, 3, 21, 0, 0, 0, loc)
	fnTS := rt.Add(15 * time.Second).Format("2006-01-02T150405")

	// Two candidate logs in the wide asymmetric window. Both have unparseable
	// REQUEST INFO timestamps, but only one mentions the right model.
	pathA := filepath.Join(dir, "v1-responses-"+fnTS+"-aaa.log")
	pathB := filepath.Join(dir, "v1-responses-"+rt.Add(45*time.Second).Format("2006-01-02T150405")+"-bbb.log")
	if err := os.WriteFile(pathA, []byte("=== REQUEST INFO ===\nTimestamp: garbage\n=== REQUEST BODY ===\n{\"model\":\"gpt-5.4\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pathB, []byte("=== REQUEST INFO ===\nTimestamp: garbage\n=== REQUEST BODY ===\n{\"model\":\"gpt-5.5\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	store := &fakeBackfillStore{
		stubs: []storage.ImportedEventStub{
			{EventKey: "import:only", Timestamp: rt.UTC(), Model: "gpt-5.5"},
		},
	}
	res, err := Backfill(context.Background(), store, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Matched != 1 {
		t.Fatalf("Matched=%d want 1 (result %+v)", res.Matched, res)
	}
	if got := store.matched["import:only"].rid; got != "bbb" {
		t.Errorf("rid=%q want bbb (model fallback should pick gpt-5.5 log)", got)
	}
}
