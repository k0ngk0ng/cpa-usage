package ingest

import (
	"testing"
	"time"
)

func TestDecodeSnapshotAndConvert(t *testing.T) {
	raw := []byte(`{
      "version": 1,
      "exported_at": "2026-05-01T00:00:00Z",
      "usage": {
        "total_requests": 2,
        "apis": {
          "sk-aaa": {
            "total_requests": 2,
            "models": {
              "claude-opus-4-7": {
                "total_requests": 2,
                "details": [
                  {"timestamp":"2026-04-30T10:00:00Z","latency_ms":1200,"source":"openai","auth_index":"a1",
                   "tokens":{"input_tokens":10,"output_tokens":20,"reasoning_tokens":0,"cached_tokens":2,"total_tokens":30},
                   "failed":false},
                  {"timestamp":"2026-04-30T10:05:00Z","latency_ms":900,"source":"openai","auth_index":"a1",
                   "tokens":{"input_tokens":5,"output_tokens":7,"reasoning_tokens":0,"cached_tokens":0,"total_tokens":12},
                   "failed":true}
                ]
              }
            }
          }
        }
      }
    }`)
	env, err := DecodeSnapshot(raw)
	if err != nil {
		t.Fatalf("DecodeSnapshot: %v", err)
	}
	if env.Version != 1 {
		t.Errorf("Version=%d want 1", env.Version)
	}
	events := SnapshotToEvents(env)
	if len(events) != 2 {
		t.Fatalf("len(events)=%d want 2", len(events))
	}
	keys := map[string]bool{}
	for _, ev := range events {
		if ev.EventKey == "" || keys[ev.EventKey] {
			t.Errorf("expected unique non-empty event_key, got %q", ev.EventKey)
		}
		keys[ev.EventKey] = true
		if ev.Model != "claude-opus-4-7" {
			t.Errorf("Model=%q", ev.Model)
		}
		if ev.APIKey != "sk-aaa" {
			t.Errorf("APIKey=%q", ev.APIKey)
		}
		if ev.APIGroupKey != "sk-aaa" {
			t.Errorf("APIGroupKey=%q want sk-aaa", ev.APIGroupKey)
		}
		if ev.Source != "openai" || ev.AuthIndex != "a1" {
			t.Errorf("Source/AuthIndex bad: %+v", ev)
		}
		if ev.RequestID != "" || ev.Provider != "" || ev.Endpoint != "" || ev.AuthType != "" {
			t.Errorf("expected empty Provider/Endpoint/AuthType/RequestID, got %+v", ev)
		}
	}
	// Re-converting must produce identical event_keys (idempotence).
	again := SnapshotToEvents(env)
	got := map[string]bool{}
	for _, ev := range again {
		got[ev.EventKey] = true
	}
	for k := range keys {
		if !got[k] {
			t.Errorf("event_key %q not stable across calls", k)
		}
	}
}

func TestDecodeSnapshotRejectsBadVersion(t *testing.T) {
	_, err := DecodeSnapshot([]byte(`{"version": 99, "usage": {}}`))
	if err == nil {
		t.Errorf("expected error for unsupported version")
	}
}

func TestSnapshotSkipsZeroTimestamp(t *testing.T) {
	env := &SnapshotEnvelope{
		Version: 1,
		Usage: StatisticsPayload{
			APIs: map[string]APIPayload{
				"k": {Models: map[string]ModelPayload{
					"m": {Details: []DetailPayload{
						{Timestamp: time.Time{}, Tokens: TokensPayload{TotalTokens: 1}},
					}},
				}},
			},
		},
	}
	if got := SnapshotToEvents(env); len(got) != 0 {
		t.Errorf("expected zero-timestamp rows to be dropped, got %d", len(got))
	}
}
