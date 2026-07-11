package cpa

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestLogReaderReadForDisplayExternalizesInlineAssets(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "v1-responses-2026-07-11T214021-abc123.log")
	imageBytes := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x42}, 8*1024)...)
	imageEncoded := base64.StdEncoding.EncodeToString(imageBytes)
	documentBytes := append([]byte("%PDF-1.7\n"), bytes.Repeat([]byte{0x43}, 8*1024)...)
	documentEncoded := base64.StdEncoding.EncodeToString(documentBytes)
	requestBody := fmt.Sprintf(`{"model":"test","input":[{"role":"user","content":[{"type":"input_text","text":"before"},{"type":"input_image","image_url":"data:image/png;base64,%s"},{"type":"input_text","text":"after"}]}],"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"%s"}},{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"%s"}}]}]}`, imageEncoded, imageEncoded, documentEncoded)
	logBody := "=== REQUEST INFO ===\nURL: /v1/responses\n\n=== REQUEST BODY ===\n" + requestBody + "\n\n=== RESPONSE ===\nStatus: 200\n"
	if err := os.WriteFile(path, []byte(logBody), 0o600); err != nil {
		t.Fatalf("write log: %v", err)
	}

	reader := &LogReader{MaxBodyBytes: 2 * 1024}
	rawEntry, err := reader.Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !rawEntry.RequestTruncated {
		t.Fatal("expected the unmodified request body to be truncated")
	}

	entry, err := reader.ReadForDisplay(path, "/usage/api/v1/usage/events/abc123/log/asset")
	if err != nil {
		t.Fatalf("ReadForDisplay: %v", err)
	}
	if entry.RequestTruncated {
		t.Fatal("compacted request body should fit without truncation")
	}
	if !json.Valid([]byte(entry.RequestBody)) {
		t.Fatalf("compacted request body is not valid JSON: %s", entry.RequestBody)
	}
	if strings.Contains(entry.RequestBody, imageEncoded) || strings.Contains(entry.RequestBody, documentEncoded) {
		t.Fatal("compacted request body still contains an inline asset payload")
	}
	if got := strings.Count(entry.RequestBody, "/log/asset?"); got != 3 {
		t.Fatalf("lazy asset URL count = %d, want 3", got)
	}

	var request map[string]any
	if err := json.Unmarshal([]byte(entry.RequestBody), &request); err != nil {
		t.Fatalf("decode compacted request: %v", err)
	}
	input := request["input"].([]any)[0].(map[string]any)
	inputContent := input["content"].([]any)
	dataURLReplacement := inputContent[1].(map[string]any)["image_url"].(string)
	messages := request["messages"].([]any)[0].(map[string]any)
	messageContent := messages["content"].([]any)
	source := messageContent[0].(map[string]any)["source"].(map[string]any)
	base64Replacement := source["data"].(string)
	documentSource := messageContent[1].(map[string]any)["source"].(map[string]any)
	documentReplacement := documentSource["data"].(string)

	assets := []struct {
		url      string
		data     []byte
		mimeType string
	}{
		{url: dataURLReplacement, data: imageBytes, mimeType: "image/png"},
		{url: base64Replacement, data: imageBytes, mimeType: "image/png"},
		{url: documentReplacement, data: documentBytes, mimeType: "application/pdf"},
	}
	for _, asset := range assets {
		parsed, err := url.Parse(asset.url)
		if err != nil {
			t.Fatalf("parse asset URL %q: %v", asset.url, err)
		}
		offset, err := strconv.ParseInt(parsed.Query().Get("offset"), 10, 64)
		if err != nil {
			t.Fatalf("parse asset offset: %v", err)
		}
		length, err := strconv.ParseInt(parsed.Query().Get("length"), 10, 64)
		if err != nil {
			t.Fatalf("parse asset length: %v", err)
		}
		decoded, mimeType, err := reader.ReadInlineAsset(path, offset, length)
		if err != nil {
			t.Fatalf("ReadInlineAsset: %v", err)
		}
		if mimeType != asset.mimeType {
			t.Fatalf("mime type = %q, want %q", mimeType, asset.mimeType)
		}
		if !bytes.Equal(decoded, asset.data) {
			t.Fatal("decoded asset bytes differ from the original payload")
		}
	}
}
