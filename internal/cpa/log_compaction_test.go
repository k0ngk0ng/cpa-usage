package cpa

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Failure cases: skipped WS sections, upstream/downstream mixing, unbounded
// transcripts, truncation not reported, and HTTP body regressions.
func TestLogReaderWebsocketCompaction(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ws.log")
	downstream := "Timestamp: 2026-10-16T10:00:00Z\nEvent: websocket.request\n{\"type\":\"response.create\",\"input\":[{\"type\":\"compaction_trigger\"}]}\n"
	upstream := "Timestamp: 2026-10-16T10:00:00Z\nEvent: websocket.response\n{\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"compaction\",\"encrypted_content\":\"opaque\"}]}}\n"
	body := "=== REQUEST INFO ===\nURL: /v1/responses/ws\n=== WEBSOCKET TIMELINE ===\n" + downstream + "=== API WEBSOCKET TIMELINE ===\n" + upstream + "=== REQUEST BODY ===\n{\"input\":\"hello\"}\n=== RESPONSE ===\nStatus: 200\n\n{}\n"
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	entry, err := (&LogReader{}).ReadForDisplay(path, "/asset")
	if err != nil {
		t.Fatal(err)
	}
	if entry.WebsocketTimeline != strings.TrimSpace(downstream) || entry.APIWebsocketTimeline != strings.TrimSpace(upstream) {
		t.Fatalf("lost/mixed websocket transcript: %+v", entry)
	}
	if entry.RequestBody != `{"input":"hello"}` || entry.ResponseBody != "Status: 200\n\n{}" {
		t.Fatal("HTTP sections changed")
	}
	small, err := (&LogReader{MaxBodyBytes: 32}).Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if !small.WebsocketTimelineTruncated || !small.APIWebsocketTimelineTruncated || len(small.WebsocketTimeline) > 32 || len(small.APIWebsocketTimeline) > 32 {
		t.Fatalf("unbounded/unmarked transcript: %+v", small)
	}
}

func TestLogReaderWebsocketHeadersRedacted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ws.log")
	body := "=== API WEBSOCKET TIMELINE ===\nTimestamp: 2026-10-16T10:00:00Z\nEvent: api.websocket.request\nHeaders:\nAuthorization: Bearer test-secret-that-must-be-masked\n\nBody:\n{\"input\":[{\"type\":\"compaction_trigger\"}]}\n"
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	entry, err := (&LogReader{}).Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(entry.APIWebsocketTimeline, "test-secret-that-must-be-masked") {
		t.Fatal("credential header leaked")
	}
	if !strings.Contains(entry.APIWebsocketTimeline, `{"input":[{"type":"compaction_trigger"}]}`) {
		t.Fatal("JSON payload changed")
	}
}
