package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
)

type requestLogDownloaderFunc func(context.Context, string, io.Writer) (cpa.RequestLogMeta, error)

func (f requestLogDownloaderFunc) DownloadRequestLog(ctx context.Context, requestID string, dst io.Writer) (cpa.RequestLogMeta, error) {
	return f(ctx, requestID, dst)
}

type requestLogRangeDownloader struct {
	download      requestLogDownloaderFunc
	downloadRange func(context.Context, string, int64, int64, io.Writer) (cpa.RequestLogMeta, error)
}

func (d requestLogRangeDownloader) DownloadRequestLog(ctx context.Context, requestID string, dst io.Writer) (cpa.RequestLogMeta, error) {
	return d.download(ctx, requestID, dst)
}

func (d requestLogRangeDownloader) DownloadRequestLogRange(ctx context.Context, requestID string, offset, length int64, dst io.Writer) (cpa.RequestLogMeta, error) {
	return d.downloadRange(ctx, requestID, offset, length, dst)
}

func TestLogAssetContentDisposition(t *testing.T) {
	if got := logAssetContentDisposition("image/png", false); got != "inline" {
		t.Fatalf("inline disposition = %q, want inline", got)
	}
	cases := map[string]string{
		"image/png":       `attachment; filename="log-asset.png"`,
		"image/jpeg":      `attachment; filename="log-asset.jpg"`,
		"application/pdf": `attachment; filename="log-asset.pdf"`,
		"unknown/type":    `attachment; filename="log-asset.bin"`,
	}
	for mimeType, want := range cases {
		if got := logAssetContentDisposition(mimeType, true); got != want {
			t.Errorf("download disposition for %s = %q, want %q", mimeType, got, want)
		}
	}
}

func TestUsageEventLogAssetHandlerDownloadsDecodedBase64(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	imageBytes := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x42}, 1024)...)
	encoded := base64.StdEncoding.EncodeToString(imageBytes)
	requestBody := `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + encoded + `"}}]}]}`
	logBody := "=== REQUEST INFO ===\nURL: /v1/messages\n\n=== REQUEST BODY ===\n" + requestBody + "\n\n=== RESPONSE ===\nStatus: 200\n"
	path := filepath.Join(dir, "v1-messages-2026-07-11T175354-abc123.log")
	if err := os.WriteFile(path, []byte(logBody), 0o600); err != nil {
		t.Fatalf("write log: %v", err)
	}

	deps := UsageDeps{
		LogReader: &cpa.LogReader{Dir: dir, MaxBodyBytes: 2 * 1024},
		LogDownloader: requestLogDownloaderFunc(func(context.Context, string, io.Writer) (cpa.RequestLogMeta, error) {
			t.Fatal("management fallback called despite local log")
			return cpa.RequestLogMeta{}, nil
		}),
	}
	assertUsageEventLogAssetDownload(t, deps, imageBytes)
}

func TestUsageEventLogAssetHandlerFallsBackToCPAManagementAPI(t *testing.T) {
	gin.SetMode(gin.TestMode)
	imageBytes := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x42}, 1024)...)
	encoded := base64.StdEncoding.EncodeToString(imageBytes)
	requestBody := `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + encoded + `"}}]}]}`
	logBody := "=== REQUEST INFO ===\nURL: /v1/messages\n\n=== REQUEST BODY ===\n" + requestBody + "\n\n=== RESPONSE ===\nStatus: 200\n"
	fullDownloads := 0
	rangeDownloads := 0
	deps := UsageDeps{
		LogReader: &cpa.LogReader{Dir: t.TempDir(), MaxBodyBytes: 2 * 1024},
		LogDownloader: requestLogRangeDownloader{
			download: func(_ context.Context, requestID string, dst io.Writer) (cpa.RequestLogMeta, error) {
				fullDownloads++
				if requestID != "abc123" {
					t.Fatalf("requestID = %q", requestID)
				}
				if _, err := io.WriteString(dst, logBody); err != nil {
					return cpa.RequestLogMeta{}, err
				}
				return cpa.RequestLogMeta{FileName: "remote-abc123.log", Size: int64(len(logBody))}, nil
			},
			downloadRange: func(_ context.Context, requestID string, offset, length int64, dst io.Writer) (cpa.RequestLogMeta, error) {
				rangeDownloads++
				if requestID != "abc123" {
					t.Fatalf("requestID = %q", requestID)
				}
				if offset < 0 || length <= 0 || offset+length > int64(len(logBody)) {
					return cpa.RequestLogMeta{}, errors.New("invalid test range")
				}
				_, err := dst.Write([]byte(logBody)[offset : offset+length])
				return cpa.RequestLogMeta{FileName: "remote-abc123.log", Size: length}, err
			},
		},
	}
	assertUsageEventLogAssetDownload(t, deps, imageBytes)
	if fullDownloads != 1 {
		t.Fatalf("full downloads = %d, want 1", fullDownloads)
	}
	if rangeDownloads != 1 {
		t.Fatalf("range downloads = %d, want 1", rangeDownloads)
	}
}

func assertUsageEventLogAssetDownload(t *testing.T, deps UsageDeps, imageBytes []byte) {
	t.Helper()
	router := gin.New()
	router.GET("/usage/events/:request_id/log", usageEventLogHandler(deps))
	router.GET("/usage/events/:request_id/log/asset", usageEventLogAssetHandler(deps))

	logResponse := httptest.NewRecorder()
	router.ServeHTTP(logResponse, httptest.NewRequest(http.MethodGet, "/usage/events/abc123/log", nil))
	if logResponse.Code != http.StatusOK {
		t.Fatalf("log status = %d, body=%s", logResponse.Code, logResponse.Body.String())
	}
	var envelope struct {
		Entry struct {
			RequestBody string `json:"request_body"`
		} `json:"entry"`
	}
	if err := json.Unmarshal(logResponse.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode log response: %v", err)
	}
	var request struct {
		Messages []struct {
			Content []struct {
				Source struct {
					Data string `json:"data"`
				} `json:"source"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(envelope.Entry.RequestBody), &request); err != nil {
		t.Fatalf("decode compacted request: %v", err)
	}
	assetURL, err := url.Parse(request.Messages[0].Content[0].Source.Data)
	if err != nil {
		t.Fatalf("parse asset URL: %v", err)
	}
	query := assetURL.Query()
	query.Set("download", "1")
	assetURL.RawQuery = query.Encode()

	assetResponse := httptest.NewRecorder()
	router.ServeHTTP(assetResponse, httptest.NewRequest(http.MethodGet, assetURL.String(), nil))
	if assetResponse.Code != http.StatusOK {
		t.Fatalf("asset status = %d, body=%s", assetResponse.Code, assetResponse.Body.String())
	}
	if got := assetResponse.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", got)
	}
	if got := assetResponse.Header().Get("Content-Disposition"); got != `attachment; filename="log-asset.png"` {
		t.Fatalf("Content-Disposition = %q", got)
	}
	if !bytes.Equal(assetResponse.Body.Bytes(), imageBytes) {
		t.Fatal("downloaded asset differs from decoded Base64")
	}
}

func TestUsageEventLogHandlersFallBackToCPAManagementAPI(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const logBody = "=== REQUEST INFO ===\nURL: /v1/responses\n\n=== REQUEST BODY ===\n{\"model\":\"gpt-test\"}\n\n=== RESPONSE ===\n{\"ok\":true}\n"
	downloader := requestLogDownloaderFunc(func(_ context.Context, requestID string, dst io.Writer) (cpa.RequestLogMeta, error) {
		if requestID != "remote123" {
			t.Fatalf("requestID = %q", requestID)
		}
		if _, err := io.WriteString(dst, logBody); err != nil {
			return cpa.RequestLogMeta{}, err
		}
		return cpa.RequestLogMeta{
			FileName: "v1-responses-2026-07-12T010203-remote123.log",
			Size:     int64(len(logBody)),
		}, nil
	})
	deps := UsageDeps{
		LogReader:     &cpa.LogReader{Dir: t.TempDir()},
		LogDownloader: downloader,
	}
	router := gin.New()
	router.GET("/usage/events/:request_id/log", usageEventLogHandler(deps))
	router.GET("/usage/events/:request_id/log/raw", usageEventLogRawHandler(deps))

	logResponse := httptest.NewRecorder()
	router.ServeHTTP(logResponse, httptest.NewRequest(http.MethodGet, "/usage/events/remote123/log", nil))
	if logResponse.Code != http.StatusOK {
		t.Fatalf("log status = %d, body=%s", logResponse.Code, logResponse.Body.String())
	}
	var envelope struct {
		Found bool `json:"found"`
		Entry struct {
			File         string `json:"file"`
			FileSize     int64  `json:"file_size_bytes"`
			RequestBody  string `json:"request_body"`
			ResponseBody string `json:"response_body"`
		} `json:"entry"`
	}
	if err := json.Unmarshal(logResponse.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode log response: %v", err)
	}
	if !envelope.Found {
		t.Fatal("found = false")
	}
	if envelope.Entry.File != "v1-responses-2026-07-12T010203-remote123.log" {
		t.Fatalf("file = %q", envelope.Entry.File)
	}
	if envelope.Entry.FileSize != int64(len(logBody)) {
		t.Fatalf("file size = %d", envelope.Entry.FileSize)
	}
	if envelope.Entry.RequestBody != `{"model":"gpt-test"}` {
		t.Fatalf("request body = %q", envelope.Entry.RequestBody)
	}
	if envelope.Entry.ResponseBody != `{"ok":true}` {
		t.Fatalf("response body = %q", envelope.Entry.ResponseBody)
	}

	rawResponse := httptest.NewRecorder()
	router.ServeHTTP(rawResponse, httptest.NewRequest(http.MethodGet, "/usage/events/remote123/log/raw", nil))
	if rawResponse.Code != http.StatusOK {
		t.Fatalf("raw status = %d, body=%s", rawResponse.Code, rawResponse.Body.String())
	}
	if rawResponse.Body.String() != logBody {
		t.Fatalf("raw body differs")
	}
	if got := rawResponse.Header().Get("Content-Disposition"); got != `attachment; filename="v1-responses-2026-07-12T010203-remote123.log"` {
		t.Fatalf("Content-Disposition = %q", got)
	}
}

func TestUsageEventLogHandlerReportsManagementFailureAsBadGateway(t *testing.T) {
	gin.SetMode(gin.TestMode)
	deps := UsageDeps{
		LogReader: &cpa.LogReader{Dir: t.TempDir()},
		LogDownloader: requestLogDownloaderFunc(func(context.Context, string, io.Writer) (cpa.RequestLogMeta, error) {
			return cpa.RequestLogMeta{}, errors.New("management unavailable")
		}),
	}
	router := gin.New()
	router.GET("/usage/events/:request_id/log", usageEventLogHandler(deps))

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/usage/events/remote123/log", nil))
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
}

func TestUsageEventLogAssetHandlerReportsRangeFailureAsBadGateway(t *testing.T) {
	gin.SetMode(gin.TestMode)
	deps := UsageDeps{
		LogReader: &cpa.LogReader{Dir: t.TempDir()},
		LogDownloader: requestLogRangeDownloader{
			download: func(context.Context, string, io.Writer) (cpa.RequestLogMeta, error) {
				return cpa.RequestLogMeta{}, errors.New("unexpected full download")
			},
			downloadRange: func(context.Context, string, int64, int64, io.Writer) (cpa.RequestLogMeta, error) {
				return cpa.RequestLogMeta{}, errors.New("range unavailable")
			},
		},
	}
	router := gin.New()
	router.GET("/usage/events/:request_id/log/asset", usageEventLogAssetHandler(deps))

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/usage/events/remote123/log/asset?offset=1&length=4", nil))
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
}
