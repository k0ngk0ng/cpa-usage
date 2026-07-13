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
		"executor_type":"ClaudeExecutor",
		"model":"claude-sonnet-4",
		"alias":"client-claude",
		"endpoint":"POST /v1/chat/completions",
		"auth_type":"apikey",
		"api_key":"test-key",
		"request_id":"ctx-request-id",
		"reasoning_effort":"medium",
		"service_tier":"priority",
		"request_service_tier":"priority",
		"response_service_tier":"default"
	}`

	ev, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if ev.EventKey == "ctx-request-id" || ev.RequestID != "ctx-request-id" {
		t.Fatalf("request ids = event_key %q request_id %q", ev.EventKey, ev.RequestID)
	}
	if ev.ExecutorType != "ClaudeExecutor" {
		t.Fatalf("executor type = %q", ev.ExecutorType)
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
	if ev.ReasoningEffort != "medium" || ev.ServiceTier != "priority" ||
		ev.RequestServiceTier != "priority" || ev.ResponseServiceTier != "default" {
		t.Fatalf("reasoning/service tiers = %q/%q/%q/%q", ev.ReasoningEffort, ev.ServiceTier, ev.RequestServiceTier, ev.ResponseServiceTier)
	}
}

func TestDecodeBuildsStableDistinctUsageEventKeys(t *testing.T) {
	first := `{"timestamp":"2026-04-25T00:00:00Z","provider":"codex","model":"gpt-5","request_id":"shared","tokens":{"input_tokens":10}}`
	second := `{"timestamp":"2026-04-25T00:00:00Z","provider":"codex","model":"gpt-image-2","request_id":"shared","tokens":{"input_tokens":20}}`

	a, err := Decode(first)
	if err != nil {
		t.Fatalf("Decode first: %v", err)
	}
	again, err := Decode(first)
	if err != nil {
		t.Fatalf("Decode first again: %v", err)
	}
	b, err := Decode(second)
	if err != nil {
		t.Fatalf("Decode second: %v", err)
	}
	if a.EventKey != again.EventKey {
		t.Fatalf("event key is not stable: %q != %q", a.EventKey, again.EventKey)
	}
	if a.EventKey == b.EventKey {
		t.Fatalf("distinct provider records share event key %q", a.EventKey)
	}
	if a.RequestID != b.RequestID {
		t.Fatalf("request ids differ: %q != %q", a.RequestID, b.RequestID)
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

func TestDecodeUsesExecutorStyleInsteadOfClaudeModelName(t *testing.T) {
	raw := `{
		"timestamp":"2026-04-25T00:00:00Z",
		"provider":"antigravity",
		"executor_type":"AntigravityExecutor",
		"model":"claude-sonnet-4-5",
		"request_id":"req-antigravity-claude",
		"tokens":{
			"input_tokens":1000,
			"output_tokens":50,
			"cached_tokens":800,
			"cache_read_tokens":800,
			"total_tokens":1050
		}
	}`

	ev, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if ev.InputTokens != 200 || ev.CachedTokens != 800 {
		t.Fatalf("normalized tokens = input %d cache %d, want 200/800", ev.InputTokens, ev.CachedTokens)
	}
}

func TestDecodeClaudeExecutorPreservesInputRegardlessOfModelName(t *testing.T) {
	raw := `{
		"timestamp":"2026-04-25T00:00:00Z",
		"provider":"custom-name",
		"executor_type":"ClaudeExecutor",
		"model":"company-model",
		"request_id":"req-claude-executor",
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
	if ev.InputTokens != 100 || ev.CachedTokens != 0 || ev.CacheCreationTokens != 900 {
		t.Fatalf("claude tokens = input %d read %d write %d", ev.InputTokens, ev.CachedTokens, ev.CacheCreationTokens)
	}
}

func TestDecodeNonClaudeExecutorOverridesProviderName(t *testing.T) {
	raw := `{
		"timestamp":"2026-04-25T00:00:00Z",
		"provider":"anthropic",
		"executor_type":"OpenAICompatExecutor",
		"model":"company-model",
		"request_id":"req-openai-compatible-anthropic-name",
		"tokens":{
			"input_tokens":1000,
			"output_tokens":50,
			"cached_tokens":800,
			"cache_read_tokens":800,
			"total_tokens":1050
		}
	}`

	ev, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if ev.InputTokens != 200 || ev.CachedTokens != 800 {
		t.Fatalf("normalized tokens = input %d cache %d, want 200/800", ev.InputTokens, ev.CachedTokens)
	}
}
