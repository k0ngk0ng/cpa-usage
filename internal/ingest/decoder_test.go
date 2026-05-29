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
		"provider":"openai",
		"model":"gpt-5.4",
		"alias":"client-gpt",
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
	if ev.Alias != "client-gpt" || ev.TTFTMs != 320 {
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
