package cpa

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLogReaderFindAndRead(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}
	sampleDir := filepath.Join(home, "Downloads", "logs")
	if _, err := os.Stat(sampleDir); err != nil {
		t.Skipf("sample dir not present: %v", err)
	}

	r := &LogReader{Dir: sampleDir}
	cases := []struct {
		name        string
		requestID   string
		wantInfoURL string
		wantHasReq  bool
		wantHasResp bool
	}{
		{"messages", "6e121b0d", "/v1/messages?beta=true", true, true},
		{"responses", "56ddc64a", "/v1/responses", true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path, err := r.FindLog(tc.requestID)
			if err != nil {
				t.Fatalf("FindLog(%q): %v", tc.requestID, err)
			}
			entry, err := r.Read(path)
			if err != nil {
				t.Fatalf("Read(%q): %v", path, err)
			}
			if got := entry.Info["URL"]; got != tc.wantInfoURL {
				t.Errorf("Info.URL: got %q want %q", got, tc.wantInfoURL)
			}
			if tc.wantHasReq && entry.RequestBody == "" {
				t.Errorf("RequestBody empty")
			}
			if tc.wantHasResp && entry.ResponseBody == "" {
				t.Errorf("ResponseBody empty")
			}
			// Authorization should be redacted.
			if v := entry.Headers["Authorization"]; v != "" && strings.Contains(v, "Bearer ") && !strings.Contains(v, "…") {
				// CPA already shortens to "Bearer sk-i...diSb" — accept either form.
				if !strings.Contains(v, "...") {
					t.Errorf("Authorization not masked: %q", v)
				}
			}
			// Upstream sections must be skipped: ResponseBody must not contain
			// the literal "API REQUEST" marker.
			if strings.Contains(entry.RequestBody, "=== API REQUEST") {
				t.Errorf("RequestBody leaked an API REQUEST marker")
			}
			if strings.Contains(entry.ResponseBody, "=== API REQUEST") {
				t.Errorf("ResponseBody leaked an API REQUEST marker")
			}
		})
	}
}

func TestFindLogInvalidRequestID(t *testing.T) {
	r := &LogReader{Dir: "/tmp"}
	if _, err := r.FindLog("../etc/passwd"); err == nil {
		t.Errorf("expected error for path-traversal request id")
	}
	if _, err := r.FindLog(""); err == nil {
		t.Errorf("expected error for empty request id")
	}
}

// TestLogReaderMultipleAPIResponses verifies that retried upstream attempts
// (multiple `=== API RESPONSE N ===` blocks) are parsed into APIResponses
// with their per-attempt status code, so the UI can distinguish a 429-then-
// 200 retry chain from a single 200.
func TestLogReaderMultipleAPIResponses(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}
	sampleDir := filepath.Join(home, "Downloads", "logs")
	if _, err := os.Stat(sampleDir); err != nil {
		t.Skipf("sample dir not present: %v", err)
	}
	r := &LogReader{Dir: sampleDir}
	path, err := r.FindLog("f27a848a")
	if err != nil {
		t.Skipf("sample log f27a848a not available: %v", err)
	}
	entry, err := r.Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(entry.APIResponses) < 2 {
		t.Fatalf("expected at least 2 APIResponses, got %d", len(entry.APIResponses))
	}
	if entry.APIResponses[0].Index != 1 || entry.APIResponses[0].Status != 429 {
		t.Errorf("APIResponses[0] = %+v, want Index=1 Status=429", entry.APIResponses[0])
	}
	if entry.APIResponses[1].Index != 2 || entry.APIResponses[1].Status != 200 {
		t.Errorf("APIResponses[1] = %+v, want Index=2 Status=200", entry.APIResponses[1])
	}
	if entry.APIResponses[0].Body == "" {
		t.Errorf("APIResponses[0].Body empty")
	}
	// Header redaction should still apply.
	for _, r := range entry.APIResponses {
		for k, v := range r.Headers {
			if strings.EqualFold(k, "set-cookie") && v != "" && !strings.Contains(v, "…") && !strings.Contains(v, "***") {
				t.Errorf("Set-Cookie not redacted in API RESPONSE %d: %q", r.Index, v)
			}
		}
	}
}
