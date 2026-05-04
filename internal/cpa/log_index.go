package cpa

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// LogIndexEntry is one CPA per-request log file located by filename only —
// no file is opened during indexing. Timestamp is parsed from the filename
// in local time because CPA writes the filename with
// `time.Now().Format("2006-01-02T150405")`.
//
// The filename timestamp reflects response-completion time, which can lag
// the actual request-received time by tens of seconds for streaming
// requests. Use LogIndex.RequestReceivedAt to get the precise time.
type LogIndexEntry struct {
	Path         string
	Timestamp    time.Time
	RequestID    string
	EndpointHint string // "/v1/messages" derived from the sanitized path prefix
}

// LogIndex is a timestamp-sorted view of every parseable filename under a
// CPA log directory. Lookups return the slice of entries whose timestamp
// falls inside a ±window of the supplied target.
type LogIndex struct {
	entries []LogIndexEntry

	// reqInfoTSCache memoises ReadRequestReceivedAt by request_id. A cache
	// hit with a zero time means we tried and failed, so callers don't
	// re-open broken files.
	reqInfoTSCache map[string]time.Time
}

const logFilenameTimeLayout = "2006-01-02T150405"

// logFilenamePattern captures (sanitized-path, timestamp, request_id) from
// filenames like "v1-messages-2026-05-03T131725-33f40551.log".
var logFilenamePattern = regexp.MustCompile(`^(.+)-(\d{4}-\d{2}-\d{2}T\d{6})-([A-Za-z0-9_-]+)\.log$`)

// BuildLogIndex walks dir (one level — CPA writes flat) and indexes every
// log filename it can parse. Unparseable files are silently skipped.
func BuildLogIndex(dir string) (*LogIndex, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return &LogIndex{}, nil
	}
	dirEntries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]LogIndexEntry, 0, len(dirEntries))
	for _, de := range dirEntries {
		if de.IsDir() {
			continue
		}
		name := de.Name()
		m := logFilenamePattern.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		ts, err := time.ParseInLocation(logFilenameTimeLayout, m[2], time.Local)
		if err != nil {
			continue
		}
		out = append(out, LogIndexEntry{
			Path:         filepath.Join(dir, name),
			Timestamp:    ts,
			RequestID:    m[3],
			EndpointHint: "/" + strings.ReplaceAll(m[1], "-", "/"),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Timestamp.Before(out[j].Timestamp) })
	return &LogIndex{
		entries:        out,
		reqInfoTSCache: make(map[string]time.Time),
	}, nil
}

// Len reports the number of indexed entries.
func (idx *LogIndex) Len() int {
	if idx == nil {
		return 0
	}
	return len(idx.entries)
}

// Around returns the slice of entries whose timestamp is within ±window of
// target. Both target and the indexed timestamps are compared as absolute
// instants, so callers do not need to align timezones.
func (idx *LogIndex) Around(target time.Time, window time.Duration) []LogIndexEntry {
	if idx == nil || len(idx.entries) == 0 {
		return nil
	}
	if window < 0 {
		window = -window
	}
	lo := target.Add(-window)
	hi := target.Add(window)
	// Binary search for the first entry >= lo.
	start := sort.Search(len(idx.entries), func(i int) bool {
		return !idx.entries[i].Timestamp.Before(lo)
	})
	out := make([]LogIndexEntry, 0, 4)
	for i := start; i < len(idx.entries); i++ {
		if idx.entries[i].Timestamp.After(hi) {
			break
		}
		out = append(out, idx.entries[i])
	}
	return out
}

// Range returns the slice of entries whose filename timestamp is in
// [start, end] (inclusive). Used for asymmetric pre-filtering when the
// event timestamp is known to be the request-received time but the
// filename reflects response-completion time, so the relevant log can
// appear well after the event.
func (idx *LogIndex) Range(start, end time.Time) []LogIndexEntry {
	if idx == nil || len(idx.entries) == 0 {
		return nil
	}
	if end.Before(start) {
		return nil
	}
	lo := sort.Search(len(idx.entries), func(i int) bool {
		return !idx.entries[i].Timestamp.Before(start)
	})
	out := make([]LogIndexEntry, 0, 4)
	for i := lo; i < len(idx.entries); i++ {
		if idx.entries[i].Timestamp.After(end) {
			break
		}
		out = append(out, idx.entries[i])
	}
	return out
}

// RequestReceivedAt returns the request-received time recorded inside the
// log file body for the given request_id, populating an internal cache on
// first read. ok=false when the entry is unknown, the file is unreadable,
// or the REQUEST INFO timestamp can't be parsed. Failed lookups are also
// cached (as a zero time) so a broken log isn't reopened repeatedly.
func (idx *LogIndex) RequestReceivedAt(requestID string) (time.Time, bool) {
	if idx == nil || requestID == "" {
		return time.Time{}, false
	}
	if t, ok := idx.reqInfoTSCache[requestID]; ok {
		if t.IsZero() {
			return time.Time{}, false
		}
		return t, true
	}
	for _, e := range idx.entries {
		if e.RequestID != requestID {
			continue
		}
		t, ok := ReadRequestReceivedAt(e.Path)
		if !ok {
			idx.reqInfoTSCache[requestID] = time.Time{}
			return time.Time{}, false
		}
		idx.reqInfoTSCache[requestID] = t
		return t, true
	}
	return time.Time{}, false
}

// Remove drops the entry with the given request_id (claimed match). No-op if
// not present.
func (idx *LogIndex) Remove(requestID string) {
	if idx == nil || requestID == "" {
		return
	}
	for i, e := range idx.entries {
		if e.RequestID == requestID {
			idx.entries = append(idx.entries[:i], idx.entries[i+1:]...)
			break
		}
	}
	delete(idx.reqInfoTSCache, requestID)
}
