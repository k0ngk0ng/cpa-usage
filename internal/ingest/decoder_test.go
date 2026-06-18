package ingest

import "testing"

func TestDecodeNewUsageQueueFields(t *testing.T) {
	raw := `{
		"timestamp":"2026-04-25T00:00:00Z",
		"latency_ms":1500,
		"ttft_ms":320,
		"source":"user@example.com",
		"auth_index":"0",
		"tokens":{
			"input_tokens":10,
			"output_tokens":20,
			"reasoning_tokens":3,
			"cached_tokens":4,
			"cache_read_tokens":4,
			"cache_creation_tokens":5,
			"total_tokens":42
		},
		"failed":true,
		"fail":{"status_code":429,"body":" rate limited "},
		"response_headers":{"Retry-After":["30"],"X-Upstream-Request-Id":["upstream-req-1"]},
		"provider":"claude",
		"model":"claude-sonnet-4",
		"alias":"client-claude",
		"endpoint":"POST /v1/chat/completions",
		"auth_type":"apikey",
		"api_key":"test-key",
		"request_id":"ctx-request-id",
		"reasoning_effort":"medium",
		"service_tier":"priority"
	}`

	ev, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if ev.EventKey != "ctx-request-id" || ev.RequestID != "ctx-request-id" {
		t.Fatalf("request ids = event_key %q request_id %q", ev.EventKey, ev.RequestID)
	}
	if ev.Alias != "client-claude" || ev.TTFTMs != 320 {
		t.Fatalf("alias/ttft = %q/%d", ev.Alias, ev.TTFTMs)
	}
	if ev.CacheReadTokens != 4 || ev.CacheCreationTokens != 5 {
		t.Fatalf("cache split = read %d creation %d", ev.CacheReadTokens, ev.CacheCreationTokens)
	}
	if ev.FailStatusCode != 429 || ev.FailBody != "rate limited" {
		t.Fatalf("fail = status %d body %q", ev.FailStatusCode, ev.FailBody)
	}
	if ev.ResponseHeaders != `{"Retry-After":["30"],"X-Upstream-Request-Id":["upstream-req-1"]}` {
		t.Fatalf("response headers = %s", ev.ResponseHeaders)
	}
	if ev.ReasoningEffort != "medium" || ev.ServiceTier != "priority" {
		t.Fatalf("reasoning/service tier = %q/%q", ev.ReasoningEffort, ev.ServiceTier)
	}
}

func TestDecodeNormalizesTotalInputStyleCacheTokens(t *testing.T) {
	raw := `{
		"timestamp":"2026-04-25T00:00:00Z",
		"provider":"openai",
		"model":"gpt-5",
		"request_id":"req-openai-cache",
		"tokens":{
			"input_tokens":1000,
			"output_tokens":50,
			"cached_tokens":900,
			"total_tokens":1050
		}
	}`

	ev, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if ev.InputTokens != 100 {
		t.Fatalf("input/new tokens = %d, want 100", ev.InputTokens)
	}
	if ev.CachedTokens != 900 || ev.CacheReadTokens != 900 || ev.CacheCreationTokens != 0 {
		t.Fatalf("cache split = cached %d read %d write %d, want 900/900/0", ev.CachedTokens, ev.CacheReadTokens, ev.CacheCreationTokens)
	}
	if ev.TotalTokens != 1050 {
		t.Fatalf("total tokens = %d, want preserved 1050", ev.TotalTokens)
	}
}

func TestDecodePreservesClaudeInputAndUsesExplicitCacheRead(t *testing.T) {
	raw := `{
		"timestamp":"2026-04-25T00:00:00Z",
		"provider":"claude",
		"model":"claude-sonnet-4",
		"request_id":"req-claude-cache",
		"tokens":{
			"input_tokens":100,
			"output_tokens":50,
			"cached_tokens":900,
			"cache_read_tokens":0,
			"cache_creation_tokens":900,
			"total_tokens":1050
		}
	}`

	ev, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if ev.InputTokens != 100 {
		t.Fatalf("input/new tokens = %d, want 100", ev.InputTokens)
	}
	if ev.CachedTokens != 0 || ev.CacheReadTokens != 0 || ev.CacheCreationTokens != 900 {
		t.Fatalf("cache split = cached %d read %d write %d, want 0/0/900", ev.CachedTokens, ev.CacheReadTokens, ev.CacheCreationTokens)
	}
	if ev.TotalTokens != 1050 {
		t.Fatalf("total tokens = %d, want preserved 1050", ev.TotalTokens)
	}
}
