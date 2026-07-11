package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
)

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

	deps := UsageDeps{LogReader: &cpa.LogReader{Dir: dir, MaxBodyBytes: 2 * 1024}}
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
