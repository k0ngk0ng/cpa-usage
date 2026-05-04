package cpa

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBuildLogIndexParsesAndSorts(t *testing.T) {
	dir := t.TempDir()
	names := []string{
		"v1-messages-2026-05-03T013000-aaa.log",
		"v1-messages-2026-05-03T013002-bbb.log",
		"v1-responses-2026-05-03T013001-ccc.log",
		"not-a-log.txt",
		"missing-timestamp-zzz.log",
	}
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("=== REQUEST INFO ===\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	idx, err := BuildLogIndex(dir)
	if err != nil {
		t.Fatalf("BuildLogIndex: %v", err)
	}
	if idx.Len() != 3 {
		t.Fatalf("indexed %d, want 3", idx.Len())
	}
	want := []string{"aaa", "ccc", "bbb"}
	for i, w := range want {
		if idx.entries[i].RequestID != w {
			t.Errorf("entry %d: got %q want %q", i, idx.entries[i].RequestID, w)
		}
	}
	if got := idx.entries[0].EndpointHint; got != "/v1/messages" {
		t.Errorf("endpoint hint: got %q", got)
	}
	if got := idx.entries[1].EndpointHint; got != "/v1/responses" {
		t.Errorf("endpoint hint (responses): got %q", got)
	}
}

func TestLogIndexAroundAndRemove(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{
		"v1-messages-2026-05-03T013000-aaa.log",
		"v1-messages-2026-05-03T013001-bbb.log",
		"v1-messages-2026-05-03T013002-ccc.log",
		"v1-messages-2026-05-03T013010-far.log",
	} {
		if err := os.WriteFile(filepath.Join(dir, n), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	idx, err := BuildLogIndex(dir)
	if err != nil {
		t.Fatal(err)
	}
	target, err := time.ParseInLocation(logFilenameTimeLayout, "2026-05-03T013001", time.Local)
	if err != nil {
		t.Fatal(err)
	}
	got := idx.Around(target, 2*time.Second)
	if len(got) != 3 {
		t.Fatalf("around=±2s expected 3 candidates, got %d", len(got))
	}
	idx.Remove("bbb")
	got = idx.Around(target, 2*time.Second)
	if len(got) != 2 {
		t.Fatalf("after remove: expected 2 candidates, got %d", len(got))
	}
	for _, e := range got {
		if e.RequestID == "bbb" {
			t.Fatal("removed entry still present")
		}
	}
}

func TestLogIndexRange(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{
		"v1-messages-2026-05-03T013000-aaa.log",
		"v1-messages-2026-05-03T013010-bbb.log",
		"v1-messages-2026-05-03T013020-ccc.log",
		"v1-messages-2026-05-03T013030-ddd.log",
	} {
		if err := os.WriteFile(filepath.Join(dir, n), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	idx, err := BuildLogIndex(dir)
	if err != nil {
		t.Fatal(err)
	}
	mustParse := func(s string) time.Time {
		t.Helper()
		v, err := time.ParseInLocation(logFilenameTimeLayout, s, time.Local)
		if err != nil {
			t.Fatalf("parse %s: %v", s, err)
		}
		return v
	}

	// Inclusive bounds — bbb at exactly 01:30:10 should be picked up.
	got := idx.Range(mustParse("2026-05-03T013010"), mustParse("2026-05-03T013020"))
	if len(got) != 2 {
		t.Fatalf("inclusive range expected 2, got %d", len(got))
	}
	if got[0].RequestID != "bbb" || got[1].RequestID != "ccc" {
		t.Errorf("unexpected ids: %s %s", got[0].RequestID, got[1].RequestID)
	}

	// End-only fence: zero matches when end < start.
	if got := idx.Range(mustParse("2026-05-03T013030"), mustParse("2026-05-03T013000")); len(got) != 0 {
		t.Errorf("inverted range should return 0, got %d", len(got))
	}

	// Range entirely before the index.
	if got := idx.Range(mustParse("2026-05-03T012000"), mustParse("2026-05-03T012959")); len(got) != 0 {
		t.Errorf("pre-index range should return 0, got %d", len(got))
	}

	// Range entirely after.
	if got := idx.Range(mustParse("2026-05-03T020000"), mustParse("2026-05-03T030000")); len(got) != 0 {
		t.Errorf("post-index range should return 0, got %d", len(got))
	}
}

func TestLogIndexRequestReceivedAtCaches(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "v1-messages-2026-05-03T013000-good.log")
	bad := filepath.Join(dir, "v1-messages-2026-05-03T013000-bad.log")
	if err := os.WriteFile(good, []byte("=== REQUEST INFO ===\nTimestamp: 2026-05-03T01:29:55+00:00\n=== HEADERS ===\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bad, []byte("garbage\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	idx, err := BuildLogIndex(dir)
	if err != nil {
		t.Fatal(err)
	}

	got, ok := idx.RequestReceivedAt("good")
	if !ok {
		t.Fatal("expected good lookup to succeed")
	}
	want, _ := time.Parse(time.RFC3339, "2026-05-03T01:29:55+00:00")
	if !got.Equal(want) {
		t.Errorf("got %s want %s", got, want)
	}

	if _, ok := idx.RequestReceivedAt("bad"); ok {
		t.Error("expected bad lookup to fail")
	}
	// Negative result must be cached so repeat calls don't reopen the file.
	if _, ok := idx.reqInfoTSCache["bad"]; !ok {
		t.Error("expected negative cache entry for bad")
	}

	// Removing should drop the cache entry too.
	idx.Remove("good")
	if _, ok := idx.reqInfoTSCache["good"]; ok {
		t.Error("expected cache to drop on Remove")
	}
}

func TestLogIndexEmptyDir(t *testing.T) {
	idx, err := BuildLogIndex("")
	if err != nil {
		t.Fatal(err)
	}
	if idx.Len() != 0 {
		t.Fatalf("empty dir: got %d entries", idx.Len())
	}
	if got := idx.Around(time.Now(), time.Second); len(got) != 0 {
		t.Fatalf("Around on empty index returned %d", len(got))
	}
}
