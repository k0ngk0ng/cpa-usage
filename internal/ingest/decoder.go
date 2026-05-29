package ingest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// Decode parses a single CPA JSON usage message into a storage.UsageEvent.
// Returns an error if request_id is missing — CPA v6.10+ always sets it; messages
// without one are dropped at the call site so we don't poison the dedup index.
func Decode(message string) (storage.UsageEvent, error) {
	if strings.TrimSpace(message) == "" {
		return storage.UsageEvent{}, fmt.Errorf("empty message")
	}
	var rec cpa.UsageRecord
	if err := json.Unmarshal([]byte(message), &rec); err != nil {
		return storage.UsageEvent{}, fmt.Errorf("decode usage record: %w", err)
	}
	requestID := strings.TrimSpace(rec.RequestID)
	if requestID == "" {
		return storage.UsageEvent{}, fmt.Errorf("usage record missing request_id")
	}
	ts := rec.Timestamp
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	return storage.UsageEvent{
		EventKey:            requestID,
		Timestamp:           ts.UTC(),
		Provider:            strings.TrimSpace(rec.Provider),
		Model:               strings.TrimSpace(rec.Model),
		Alias:               strings.TrimSpace(rec.Alias),
		APIGroupKey:         resolveAPIGroupKey(rec),
		Source:              strings.TrimSpace(rec.Source),
		AuthIndex:           strings.TrimSpace(rec.AuthIndex),
		AuthType:            strings.TrimSpace(rec.AuthType),
		APIKey:              strings.TrimSpace(rec.APIKey),
		Endpoint:            strings.TrimSpace(rec.Endpoint),
		RequestID:           requestID,
		LatencyMs:           rec.LatencyMs,
		TTFTMs:              rec.TTFTMs,
		InputTokens:         rec.Tokens.InputTokens,
		OutputTokens:        rec.Tokens.OutputTokens,
		ReasoningTokens:     rec.Tokens.ReasoningTokens,
		CachedTokens:        rec.Tokens.CachedTokens,
		CacheReadTokens:     rec.Tokens.CacheReadTokens,
		CacheCreationTokens: rec.Tokens.CacheCreationTokens,
		TotalTokens:         rec.Tokens.TotalTokens,
		Failed:              rec.Failed,
		FailStatusCode:      rec.Fail.StatusCode,
		FailBody:            strings.TrimSpace(rec.Fail.Body),
		ResponseHeaders:     compactRawJSON(rec.ResponseHeaders),
		ReasoningEffort:     strings.TrimSpace(rec.ReasoningEffort),
		ServiceTier:         strings.TrimSpace(rec.ServiceTier),
		InsertedAt:          time.Now().UTC(),
	}, nil
}

// DecodeBatch decodes a slice of raw queue messages, returning the successfully
// parsed events and the count of messages that failed to decode.
func DecodeBatch(messages []string) ([]storage.UsageEvent, int) {
	events := make([]storage.UsageEvent, 0, len(messages))
	dropped := 0
	for _, m := range messages {
		ev, err := Decode(m)
		if err != nil {
			dropped++
			continue
		}
		events = append(events, ev)
	}
	return events, dropped
}

// resolveAPIGroupKey picks api_key → provider → endpoint → "unknown" — same
// preference order used by cpa-usage-keeper so existing pricing/aggregation
// continues to work.
func resolveAPIGroupKey(rec cpa.UsageRecord) string {
	if v := strings.TrimSpace(rec.APIKey); v != "" {
		return v
	}
	if v := strings.TrimSpace(rec.Provider); v != "" {
		return v
	}
	if v := strings.TrimSpace(rec.Endpoint); v != "" {
		return v
	}
	return "unknown"
}

func compactRawJSON(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) || !json.Valid(raw) {
		return ""
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return ""
	}
	return buf.String()
}
