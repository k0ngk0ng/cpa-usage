package cpa

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReadRequestReceivedAt(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		body    string
		want    string // RFC3339Nano; "" means ok=false
		wantOK  bool
	}{
		{
			name: "rfc3339nano",
			body: "=== REQUEST INFO ===\nVersion: 6.9.45\nURL: /v1/responses\nTimestamp: 2026-05-03T21:42:56.627072712+08:00\n\n=== HEADERS ===\nfoo: bar\n",
			want: "2026-05-03T21:42:56.627072712+08:00", wantOK: true,
		},
		{
			name: "rfc3339_only",
			body: "=== REQUEST INFO ===\nTimestamp: 2026-05-03T21:42:56+08:00\n=== HEADERS ===\n",
			want: "2026-05-03T21:42:56+08:00", wantOK: true,
		},
		{
			name:   "missing_section",
			body:   "no markers here at all\n",
			wantOK: false,
		},
		{
			name:   "no_timestamp_in_section",
			body:   "=== REQUEST INFO ===\nVersion: 6\n=== HEADERS ===\n",
			wantOK: false,
		},
		{
			name:   "garbage_timestamp",
			body:   "=== REQUEST INFO ===\nTimestamp: not-a-time\n=== HEADERS ===\n",
			wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name+".log")
			if err := os.WriteFile(path, []byte(tc.body), 0o600); err != nil {
				t.Fatal(err)
			}
			got, ok := ReadRequestReceivedAt(path)
			if ok != tc.wantOK {
				t.Fatalf("ok=%v want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			want, _ := time.Parse(time.RFC3339Nano, tc.want)
			if !got.Equal(want) {
				t.Errorf("got %s want %s", got, want)
			}
		})
	}
}

func TestReadRequestReceivedAtMissingFile(t *testing.T) {
	if _, ok := ReadRequestReceivedAt("/no/such/path"); ok {
		t.Errorf("expected ok=false for missing file")
	}
}
