package ingest

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// SnapshotEnvelope mirrors the legacy CPA `/v0/management/usage/export`
// response. Fields not used here (`generated_at`, etc.) are tolerated by JSON.
type SnapshotEnvelope struct {
	Version    int               `json:"version"`
	ExportedAt time.Time         `json:"exported_at"`
	Usage      StatisticsPayload `json:"usage"`
}

// StatisticsPayload is the aggregated metrics body. Only `apis` carries the
// per-request details we need for backfill; the by_day/by_hour bucket fields
// are recomputed from the events when cpa-usage queries.
type StatisticsPayload struct {
	APIs map[string]APIPayload `json:"apis"`
}

// APIPayload is one api_key bucket in the snapshot.
type APIPayload struct {
	Models map[string]ModelPayload `json:"models"`
}

// ModelPayload is one model bucket inside an APIPayload.
type ModelPayload struct {
	Details []DetailPayload `json:"details"`
}

// DetailPayload is one row in the legacy in-memory `Details` slice.
// The legacy server keeps every recorded request here.
type DetailPayload struct {
	Timestamp time.Time     `json:"timestamp"`
	LatencyMs int64         `json:"latency_ms"`
	Source    string        `json:"source"`
	AuthIndex string        `json:"auth_index"`
	Tokens    TokensPayload `json:"tokens"`
	Failed    bool          `json:"failed"`
}

// TokensPayload mirrors the legacy `TokenStats` JSON.
type TokensPayload struct {
	InputTokens     int64 `json:"input_tokens"`
	OutputTokens    int64 `json:"output_tokens"`
	ReasoningTokens int64 `json:"reasoning_tokens"`
	CachedTokens    int64 `json:"cached_tokens"`
	TotalTokens     int64 `json:"total_tokens"`
}

// DecodeSnapshot parses the legacy export envelope from raw JSON bytes.
func DecodeSnapshot(raw []byte) (*SnapshotEnvelope, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("empty snapshot")
	}
	var env SnapshotEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("decode snapshot: %w", err)
	}
	if env.Version != 0 && env.Version != 1 {
		return nil, fmt.Errorf("unsupported snapshot version %d", env.Version)
	}
	return &env, nil
}

// SnapshotToEvents flattens every detail row in the snapshot into a
// storage.UsageEvent. event_key is a stable hash so re-importing the same
// export is idempotent (the InsertUsageEvents ON CONFLICT DO NOTHING path).
//
// Fields the legacy export does not carry — request_id, provider, endpoint,
// auth_type — are left empty. APIGroupKey is set to the api_key bucket so
// pricing/aggregation views key off the same value as live events.
func SnapshotToEvents(env *SnapshotEnvelope) []storage.UsageEvent {
	if env == nil {
		return nil
	}
	now := time.Now().UTC()
	out := make([]storage.UsageEvent, 0, 1024)
	for apiKey, api := range env.Usage.APIs {
		for model, mp := range api.Models {
			for _, d := range mp.Details {
				ts := d.Timestamp
				if ts.IsZero() {
					continue
				}
				ev := storage.UsageEvent{
					EventKey:        snapshotEventKey(apiKey, model, d),
					Timestamp:       ts.UTC(),
					Model:           strings.TrimSpace(model),
					APIGroupKey:     resolveAPIGroup(apiKey),
					APIKey:          strings.TrimSpace(apiKey),
					Source:          strings.TrimSpace(d.Source),
					AuthIndex:       strings.TrimSpace(d.AuthIndex),
					LatencyMs:       d.LatencyMs,
					InputTokens:     d.Tokens.InputTokens,
					OutputTokens:    d.Tokens.OutputTokens,
					ReasoningTokens: d.Tokens.ReasoningTokens,
					CachedTokens:    d.Tokens.CachedTokens,
					TotalTokens:     d.Tokens.TotalTokens,
					Failed:          d.Failed,
					InsertedAt:      now,
				}
				out = append(out, ev)
			}
		}
	}
	return out
}

// snapshotEventKey is sha1(api_key|model|timestamp|auth_index|input|output|total|latency|failed),
// prefixed with "import:" so these rows are visually distinguishable from
// real CPA request_ids in the events table.
func snapshotEventKey(apiKey, model string, d DetailPayload) string {
	h := sha1.New()
	fmt.Fprintf(
		h,
		"%s|%s|%s|%s|%d|%d|%d|%d|%d|%t",
		apiKey, model,
		d.Timestamp.UTC().Format(time.RFC3339Nano),
		d.AuthIndex,
		d.Tokens.InputTokens, d.Tokens.OutputTokens,
		d.Tokens.ReasoningTokens, d.Tokens.TotalTokens,
		d.LatencyMs, d.Failed,
	)
	return "import:" + hex.EncodeToString(h.Sum(nil))
}

func resolveAPIGroup(apiKey string) string {
	if v := strings.TrimSpace(apiKey); v != "" {
		return v
	}
	return "unknown"
}
