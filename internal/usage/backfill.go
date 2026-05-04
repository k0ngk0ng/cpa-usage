// Package usage — backfill module.
//
// After the legacy snapshot import (POST /usage/import) lands rows that lack
// a request_id (the export payload doesn't carry one), Backfill scans the
// CPA per-request log directory and tries to attach a request_id (and an
// endpoint hint) to each imported row by matching event timestamps to log
// filenames within a small ± window. Disambiguation by model name parsed
// from the candidate's request body is best-effort: when a single candidate
// remains it's claimed; otherwise the row is left untouched.
package usage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// BackfillResult is the response shape of the manual-backfill endpoint.
type BackfillResult struct {
	Total      int    `json:"total"`
	Matched    int    `json:"matched"`
	Ambiguous  int    `json:"ambiguous"`
	Missing    int    `json:"missing"`
	LogsIndexed int   `json:"logs_indexed"`
	LogDir     string `json:"log_dir"`
}

// Backfill walks the imported events that still lack a request_id and tries
// to attach one by matching against CPA per-request log filenames in
// logDir. The match window is ±2s around the event timestamp.
//
// Once a log entry is claimed by an event, it is removed from the in-memory
// index so the same request_id cannot be assigned to two different events.
func Backfill(ctx context.Context, store storage.Store, logDir string) (*BackfillResult, error) {
	logDir = strings.TrimSpace(logDir)
	if logDir == "" {
		return nil, fmt.Errorf("CPA_LOG_DIR is not configured")
	}
	if st, err := os.Stat(logDir); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("log directory not accessible: %s", logDir)
	}
	idx, err := cpa.BuildLogIndex(logDir)
	if err != nil {
		return nil, fmt.Errorf("scan log dir: %w", err)
	}
	stubs, err := store.ListImportedEventsMissingRequestID(ctx)
	if err != nil {
		return nil, fmt.Errorf("list imported events: %w", err)
	}
	result := &BackfillResult{
		Total:       len(stubs),
		LogsIndexed: idx.Len(),
		LogDir:      logDir,
	}
	if len(stubs) == 0 || idx.Len() == 0 {
		result.Missing = len(stubs)
		return result, nil
	}

	const window = 2 * time.Second
	for _, ev := range stubs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		candidates := idx.Around(ev.Timestamp, window)
		if len(candidates) == 0 {
			result.Missing++
			continue
		}
		var match *cpa.LogIndexEntry
		switch len(candidates) {
		case 1:
			c := candidates[0]
			match = &c
		default:
			match = disambiguateByModel(candidates, ev.Model)
		}
		if match == nil {
			result.Ambiguous++
			continue
		}
		if err := store.UpdateImportedEventLink(ctx, ev.EventKey, match.RequestID, match.EndpointHint); err != nil {
			return nil, fmt.Errorf("update %s: %w", ev.EventKey, err)
		}
		idx.Remove(match.RequestID)
		result.Matched++
	}
	return result, nil
}

// disambiguateByModel returns the unique candidate whose log file's request
// body declares the given model. Returns nil if the model is empty, no log
// matches, or more than one log matches.
func disambiguateByModel(candidates []cpa.LogIndexEntry, model string) *cpa.LogIndexEntry {
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}
	var winner *cpa.LogIndexEntry
	for i := range candidates {
		c := candidates[i]
		body, ok := readRequestBodyModel(c.Path)
		if !ok {
			continue
		}
		if body != model {
			continue
		}
		if winner != nil {
			return nil
		}
		winner = &candidates[i]
	}
	return winner
}

// readRequestBodyModel cheaply extracts the top-level "model" string from
// the REQUEST BODY section of a CPA log. It only reads enough of the file
// to find the section and the field — full parsing is unnecessary.
func readRequestBodyModel(path string) (string, bool) {
	const maxBytes = 256 * 1024
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	buf := make([]byte, maxBytes)
	n, _ := f.Read(buf)
	if n == 0 {
		return "", false
	}
	text := string(buf[:n])
	const marker = "=== REQUEST BODY ==="
	idx := strings.Index(text, marker)
	if idx < 0 {
		return "", false
	}
	rest := text[idx+len(marker):]
	if next := strings.Index(rest, "\n=== "); next >= 0 {
		rest = rest[:next]
	}
	rest = strings.TrimSpace(rest)
	// Try strict JSON first. CPA logs the request body as a single JSON
	// document (sometimes pretty-printed) — a plain Unmarshal works.
	var doc map[string]any
	if err := json.Unmarshal([]byte(rest), &doc); err == nil {
		if m, ok := doc["model"].(string); ok && m != "" {
			return m, true
		}
	}
	// Fallback: regex-style scan for the first "model": "..." occurrence.
	if i := strings.Index(rest, `"model"`); i >= 0 {
		segment := rest[i:]
		if j := strings.Index(segment, ":"); j >= 0 {
			segment = strings.TrimSpace(segment[j+1:])
			if strings.HasPrefix(segment, `"`) {
				segment = segment[1:]
				if k := strings.Index(segment, `"`); k > 0 {
					return segment[:k], true
				}
			}
		}
	}
	return "", false
}
