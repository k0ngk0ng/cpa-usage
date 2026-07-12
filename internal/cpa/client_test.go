package cpa

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientDownloadRequestLog(t *testing.T) {
	const body = "=== REQUEST INFO ===\nURL: /v1/responses\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/management/request-log-by-id/abc123" {
			t.Errorf("path = %q", r.URL.Path)
			http.Error(w, "unexpected path", http.StatusBadRequest)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("Authorization = %q", got)
			http.Error(w, "unexpected authorization", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="v1-responses-2026-07-12T010203-abc123.log"`)
		w.Header().Set("X-CPA-VERSION", "v7.2.67")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret", time.Second)
	var dst bytes.Buffer
	meta, err := client.DownloadRequestLog(context.Background(), "abc123", &dst)
	if err != nil {
		t.Fatalf("DownloadRequestLog: %v", err)
	}
	if dst.String() != body {
		t.Fatalf("body = %q", dst.String())
	}
	if meta.FileName != "v1-responses-2026-07-12T010203-abc123.log" {
		t.Fatalf("FileName = %q", meta.FileName)
	}
	if meta.Size != int64(len(body)) {
		t.Fatalf("Size = %d, want %d", meta.Size, len(body))
	}
	if got := client.Version().Version; got != "v7.2.67" {
		t.Fatalf("Version = %q", got)
	}
}

func TestClientDownloadRequestLogNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "missing", http.StatusNotFound)
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret", time.Second)
	var dst bytes.Buffer
	_, err := client.DownloadRequestLog(context.Background(), "abc123", &dst)
	if !errors.Is(err, ErrLogNotFound) {
		t.Fatalf("error = %v, want ErrLogNotFound", err)
	}
}

func TestClientDownloadRequestLogRange(t *testing.T) {
	const rangedBody = "selected-range"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Range"); got != "bytes=100-113" {
			t.Errorf("Range = %q", got)
			http.Error(w, "unexpected range", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Range", "bytes 100-113/1000")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte(rangedBody))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret", time.Second)
	var dst bytes.Buffer
	meta, err := client.DownloadRequestLogRange(context.Background(), "abc123", 100, int64(len(rangedBody)), &dst)
	if err != nil {
		t.Fatalf("DownloadRequestLogRange: %v", err)
	}
	if dst.String() != rangedBody {
		t.Fatalf("body = %q", dst.String())
	}
	if meta.Size != int64(len(rangedBody)) {
		t.Fatalf("Size = %d, want %d", meta.Size, len(rangedBody))
	}
}

func TestClientDownloadRequestLogRangeHandlesIgnoredRange(t *testing.T) {
	const body = "prefix-selected-suffix"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret", time.Second)
	var dst bytes.Buffer
	_, err := client.DownloadRequestLogRange(context.Background(), "abc123", 7, 8, &dst)
	if err != nil {
		t.Fatalf("DownloadRequestLogRange: %v", err)
	}
	if dst.String() != "selected" {
		t.Fatalf("body = %q", dst.String())
	}
}

func TestRequestLogFileNameSanitizesAttachment(t *testing.T) {
	header := http.Header{}
	header.Set("Content-Disposition", `attachment; filename="../nested\\request.log"`)
	if got := requestLogFileName(header, "abc123"); got != "request.log" {
		t.Fatalf("filename = %q", got)
	}
}
