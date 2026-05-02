package cpa

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// LogReader locates and parses CPA per-request log files written under
// <CPA_LOG_DIR>/<sanitized-path>-<timestamp>-<request_id>.log. It deliberately
// surfaces only the user-facing portions of each file (REQUEST INFO, HEADERS,
// REQUEST BODY, final RESPONSE) — the upstream "API REQUEST/RESPONSE N"
// sections are skipped because they're duplicates of the user request after
// rewrites.
type LogReader struct {
	Dir            string
	MaxBodyBytes   int64
	MaxHeaderBytes int64
}

// LogEntry is the structured view we hand to the API layer.
type LogEntry struct {
	File              string            `json:"file"`
	Info              map[string]string `json:"info"`
	Headers           map[string]string `json:"headers"`
	RequestBody       string            `json:"request_body"`
	RequestTruncated  bool              `json:"request_body_truncated"`
	ResponseBody      string            `json:"response_body"`
	ResponseTruncated bool              `json:"response_body_truncated"`
}

// ErrLogNotFound is returned when no log file matches the request id.
var ErrLogNotFound = errors.New("log not found")

// requestIDPattern restricts the request id to a path-safe alphabet so we can
// safely interpolate it into a glob pattern.
var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// FindLog returns the most recent log file matching *<request_id>*.log.
// Returns ErrLogNotFound if nothing matches.
func (r *LogReader) FindLog(requestID string) (string, error) {
	if r == nil || strings.TrimSpace(r.Dir) == "" {
		return "", ErrLogNotFound
	}
	if !requestIDPattern.MatchString(requestID) {
		return "", fmt.Errorf("invalid request id")
	}
	matches, err := filepath.Glob(filepath.Join(r.Dir, "*-"+requestID+".log"))
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", ErrLogNotFound
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	type fileWithMtime struct {
		path string
		mod  int64
	}
	with := make([]fileWithMtime, 0, len(matches))
	for _, m := range matches {
		st, err := os.Stat(m)
		if err != nil {
			continue
		}
		with = append(with, fileWithMtime{path: m, mod: st.ModTime().UnixNano()})
	}
	if len(with) == 0 {
		return "", ErrLogNotFound
	}
	sort.Slice(with, func(i, j int) bool { return with[i].mod > with[j].mod })
	return with[0].path, nil
}

// Read parses the log file at path into a LogEntry. Bodies are truncated
// (with a flag) when they exceed the configured limits; default limits are
// applied when the receiver was zero-initialized.
func (r *LogReader) Read(path string) (*LogEntry, error) {
	maxBody := r.MaxBodyBytes
	if maxBody <= 0 {
		maxBody = 1 << 20 // 1 MiB
	}
	maxHeader := r.MaxHeaderBytes
	if maxHeader <= 0 {
		maxHeader = 32 * 1024
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	br := bufio.NewReaderSize(f, 64*1024)

	entry := &LogEntry{
		File:    filepath.Base(path),
		Info:    map[string]string{},
		Headers: map[string]string{},
	}

	// Section state. We stream the file, recognizing `=== NAME ===` markers
	// and routing subsequent lines to the right collector. Upstream sections
	// (`API REQUEST` / `API RESPONSE`) are routed to /dev/null.
	const (
		sectionNone     = ""
		sectionInfo     = "REQUEST INFO"
		sectionHeaders  = "HEADERS"
		sectionRequest  = "REQUEST BODY"
		sectionResponse = "RESPONSE"
		sectionSkip     = "SKIP"
	)
	section := sectionNone

	var (
		reqBuf      strings.Builder
		respBuf     strings.Builder
		reqTrunc    bool
		respTrunc   bool
		headerBytes int64
	)

	for {
		line, err := br.ReadString('\n')
		if line != "" {
			trimmed := strings.TrimRight(line, "\r\n")
			if marker, ok := parseSectionMarker(trimmed); ok {
				switch {
				case marker == sectionInfo:
					section = sectionInfo
				case marker == sectionHeaders:
					section = sectionHeaders
				case marker == sectionRequest:
					section = sectionRequest
				case marker == sectionResponse:
					section = sectionResponse
				case strings.HasPrefix(marker, "API REQUEST") || strings.HasPrefix(marker, "API RESPONSE"):
					section = sectionSkip
				default:
					section = sectionSkip
				}
			} else {
				switch section {
				case sectionInfo:
					if k, v, ok := splitKV(trimmed); ok {
						entry.Info[k] = v
					}
				case sectionHeaders:
					if k, v, ok := splitKV(trimmed); ok && headerBytes < maxHeader {
						v = redactHeader(k, v)
						entry.Headers[k] = v
						headerBytes += int64(len(k) + len(v))
					}
				case sectionRequest:
					if !reqTrunc {
						remaining := maxBody - int64(reqBuf.Len())
						if remaining <= 0 {
							reqTrunc = true
						} else if int64(len(line)) > remaining {
							reqBuf.WriteString(line[:remaining])
							reqTrunc = true
						} else {
							reqBuf.WriteString(line)
						}
					}
				case sectionResponse:
					if !respTrunc {
						remaining := maxBody - int64(respBuf.Len())
						if remaining <= 0 {
							respTrunc = true
						} else if int64(len(line)) > remaining {
							respBuf.WriteString(line[:remaining])
							respTrunc = true
						} else {
							respBuf.WriteString(line)
						}
					}
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
	}

	entry.RequestBody = strings.TrimRight(reqBuf.String(), "\n")
	entry.RequestTruncated = reqTrunc
	entry.ResponseBody = strings.TrimRight(respBuf.String(), "\n")
	entry.ResponseTruncated = respTrunc
	return entry, nil
}

// parseSectionMarker returns the inner name (e.g. "REQUEST INFO") if the line
// is a CPA-style section marker, else ok=false.
func parseSectionMarker(line string) (string, bool) {
	if !strings.HasPrefix(line, "=== ") || !strings.HasSuffix(line, " ===") {
		return "", false
	}
	inner := strings.TrimSpace(line[4 : len(line)-4])
	if inner == "" {
		return "", false
	}
	return inner, true
}

// splitKV pulls a "Key: value" pair out of a header/info line. Returns
// ok=false on blank lines or lines without a colon.
func splitKV(line string) (string, string, bool) {
	if line = strings.TrimSpace(line); line == "" {
		return "", "", false
	}
	idx := strings.Index(line, ":")
	if idx <= 0 {
		return "", "", false
	}
	return strings.TrimSpace(line[:idx]), strings.TrimSpace(line[idx+1:]), true
}

// redactHeader masks credential-bearing headers; CPA itself already shortens
// the value (`Bearer sk-i...diSb`) but we re-mask defensively.
func redactHeader(key, value string) string {
	switch strings.ToLower(key) {
	case "authorization", "cookie", "set-cookie", "x-api-key", "x-anthropic-api-key", "x-goog-api-key":
		return maskCredential(value)
	}
	return value
}

func maskCredential(value string) string {
	v := strings.TrimSpace(value)
	if v == "" {
		return ""
	}
	if len(v) <= 12 {
		return "***"
	}
	return v[:6] + "…" + v[len(v)-4:]
}
