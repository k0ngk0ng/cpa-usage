package ingest

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"github.com/k0ngk0ng/cpa-usage/internal/tokenusage"
)

// Decode parses a single CPA JSON usage message into a storage.UsageEvent.
// request_id is intentionally optional: direct SDK/plugin calls and result-only
// provider attempts can be valid usage records without an HTTP request log.
func Decode(message string) (storage.UsageEvent, error) {
	if strings.TrimSpace(message) == "" {
		return storage.UsageEvent{}, fmt.Errorf("empty message")
	}
	var rec cpa.UsageRecord
	if err := json.Unmarshal([]byte(message), &rec); err != nil {
		return storage.UsageEvent{}, fmt.Errorf("decode usage record: %w", err)
	}
	requestID := strings.TrimSpace(rec.RequestID)
	ts := rec.Timestamp
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	tokens := normalizeUsageTokens(rec)
	requestServiceTier := firstNonEmptyString(rec.ServiceTier, rec.RequestServiceTier)
	generate := true
	if rec.Generate != nil {
		generate = *rec.Generate
	}
	return storage.UsageEvent{
		EventKey:            usageEventKey(message),
		Timestamp:           ts.UTC(),
		Provider:            strings.TrimSpace(rec.Provider),
		ExecutorType:        strings.TrimSpace(rec.ExecutorType),
		Model:               strings.TrimSpace(rec.Model),
		Alias:               strings.TrimSpace(rec.Alias),
		APIGroupKey:         resolveAPIGroupKey(rec),
		Source:              strings.TrimSpace(rec.Source),
		AuthIndex:           strings.TrimSpace(rec.AuthIndex),
		AccessTokenSHA256:   strings.TrimSpace(rec.AccessTokenSHA256),
		ClientIP:            strings.TrimSpace(rec.ClientIP),
		XForwardedFor:       strings.TrimSpace(rec.XForwardedFor),
		UserAgent:           strings.TrimSpace(rec.UserAgent),
		AuthType:            strings.TrimSpace(rec.AuthType),
		APIKey:              strings.TrimSpace(rec.APIKey),
		Endpoint:            strings.TrimSpace(rec.Endpoint),
		RequestID:           requestID,
		LatencyMs:           rec.LatencyMs,
		TTFTMs:              rec.TTFTMs,
		InputTokens:         tokens.InputTokens,
		OutputTokens:        tokens.OutputTokens,
		ReasoningTokens:     tokens.ReasoningTokens,
		CachedTokens:        tokens.CachedTokens,
		CacheReadTokens:     tokens.CacheReadTokens,
		CacheReadPresent:    tokens.CacheReadPresent,
		CacheCreationTokens: tokens.CacheCreationTokens,
		NonReasoningTokens:  tokens.NonReasoningTokens,
		UnclassifiedTokens:  tokens.UnclassifiedTokens,
		TotalTokens:         tokens.TotalTokens,
		AccountingVersion:   tokens.AccountingVersion,
		AccountingQuality:   tokens.AccountingQuality,
		Failed:              rec.Failed,
		Generate:            generate,
		FailStatusCode:      rec.Fail.StatusCode,
		FailBody:            strings.TrimSpace(rec.Fail.Body),
		ResponseHeaders:     compactRawJSON(rec.ResponseHeaders),
		ReasoningEffort:     strings.TrimSpace(rec.ReasoningEffort),
		ServiceTier:         requestServiceTier,
		RequestServiceTier:  requestServiceTier,
		ResponseServiceTier: strings.TrimSpace(rec.ResponseServiceTier),
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

type normalizedUsageTokens struct {
	InputTokens         int64
	OutputTokens        int64
	ReasoningTokens     int64
	CachedTokens        int64
	CacheReadTokens     int64
	CacheReadPresent    bool
	CacheCreationTokens int64
	NonReasoningTokens  int64
	UnclassifiedTokens  int64
	TotalTokens         int64
	AccountingVersion   int
	AccountingQuality   string
}

func normalizeUsageTokens(rec cpa.UsageRecord) normalizedUsageTokens {
	if rec.AccountingVersion == tokenusage.AccountingVersionV2 && rec.TokenBreakdown.Valid() {
		breakdown := rec.TokenBreakdown
		return normalizedUsageTokens{
			InputTokens:         breakdown.Input.UncachedTokens,
			OutputTokens:        breakdown.Output.TotalTokens,
			ReasoningTokens:     breakdown.Output.ReasoningTokens,
			CachedTokens:        breakdown.Input.CacheReadTokens,
			CacheReadTokens:     breakdown.Input.CacheReadTokens,
			CacheReadPresent:    true,
			CacheCreationTokens: breakdown.Input.CacheWriteTokens,
			NonReasoningTokens:  breakdown.Output.NonReasoningTokens,
			UnclassifiedTokens:  breakdown.UnclassifiedTokens,
			TotalTokens:         breakdown.TotalTokens,
			AccountingVersion:   rec.AccountingVersion,
			AccountingQuality:   breakdown.Quality,
		}
	}

	tokens := rec.Tokens
	style := tokenusage.StyleFor(rec.Provider, rec.ExecutorType)
	if style == tokenusage.StyleIndependent {
		if tokens.CacheReadTokensPresent || tokens.CacheReadTokens != 0 || tokens.CacheCreationTokens != 0 {
			tokens.CachedTokens = tokens.CacheReadTokens
		}
	} else if style == tokenusage.StyleSubset || style == tokenusage.StyleSeparateReasoning {
		cacheRead := tokens.CacheReadTokens
		if !tokens.CacheReadTokensPresent && cacheRead == 0 {
			cacheRead = tokens.CachedTokens
		}
		if cachedInput, ok := nonNegativeSum(cacheRead, tokens.CacheCreationTokens); ok && cachedInput > 0 {
			tokens.InputTokens = subtractFloor(tokens.InputTokens, cachedInput)
		}
		tokens.CachedTokens = cacheRead
		tokens.CacheReadTokens = cacheRead
	}
	quality := "legacy"
	if rec.AccountingVersion != 0 || rec.TokenBreakdown.SchemaVersion != 0 {
		quality = "invalid"
	}
	return normalizedUsageTokens{
		InputTokens:         tokens.InputTokens,
		OutputTokens:        tokens.OutputTokens,
		ReasoningTokens:     tokens.ReasoningTokens,
		CachedTokens:        tokens.CachedTokens,
		CacheReadTokens:     tokens.CacheReadTokens,
		CacheReadPresent:    tokens.CacheReadTokensPresent,
		CacheCreationTokens: tokens.CacheCreationTokens,
		NonReasoningTokens:  tokenusage.LegacyNonReasoning(rec.Provider, rec.ExecutorType, tokens.OutputTokens, tokens.ReasoningTokens),
		TotalTokens:         tokens.TotalTokens,
		AccountingVersion:   rec.AccountingVersion,
		AccountingQuality:   quality,
	}
}

func usageEventKey(message string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(message)))
	return fmt.Sprintf("usage:%x", sum[:])
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func subtractFloor(value, delta int64) int64 {
	if delta <= 0 {
		return value
	}
	if value <= delta {
		return 0
	}
	return value - delta
}

func nonNegativeSum(values ...int64) (int64, bool) {
	var total int64
	const maxInt64 = int64(^uint64(0) >> 1)
	for _, value := range values {
		if value < 0 || total > maxInt64-value {
			return 0, false
		}
		total += value
	}
	return total, true
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
