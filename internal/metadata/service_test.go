package metadata

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/storage/sqlite"
)

func TestSyncIncludesInteractionsProviderMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v0/management/auth-files":
			_, _ = w.Write([]byte(`{"files":[]}`))
		case "/v0/management/gemini-api-key":
			_, _ = w.Write([]byte(`{"gemini-api-key":[{"api-key":"shared-google-key","prefix":"gemini"}]}`))
		case "/v0/management/interactions-api-key":
			_, _ = w.Write([]byte(`{"interactions-api-key":[{"api-key":"shared-google-key","prefix":"native"},{"api-key":"interaction-key","prefix":"native"}]}`))
		case "/v0/management/claude-api-key":
			_, _ = w.Write([]byte(`{"claude-api-key":[]}`))
		case "/v0/management/codex-api-key":
			_, _ = w.Write([]byte(`{"codex-api-key":[]}`))
		case "/v0/management/vertex-api-key":
			_, _ = w.Write([]byte(`{"vertex-api-key":[]}`))
		case "/v0/management/openai-compatibility":
			_, _ = w.Write([]byte(`{"openai-compatibility":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	store, err := sqlite.Open(sqlite.Config{Path: filepath.Join(t.TempDir(), "metadata.db")})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	service := New(cpa.NewClient(server.URL, "secret", time.Second), store, nil)
	if err := service.Sync(context.Background()); err != nil {
		t.Fatalf("Sync: %v", err)
	}
	items, err := store.ListProviderMetadata(context.Background())
	if err != nil {
		t.Fatalf("ListProviderMetadata: %v", err)
	}
	found := false
	for _, item := range items {
		if item.LookupKey == "interaction-key" && item.ProviderType == "interactions" && item.DisplayName == "native" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("interactions metadata not found in %#v", items)
	}
}

func TestSyncToleratesMissingInteractionsEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v0/management/auth-files":
			_, _ = w.Write([]byte(`{"files":[]}`))
		case "/v0/management/gemini-api-key":
			_, _ = w.Write([]byte(`{"gemini-api-key":[]}`))
		case "/v0/management/interactions-api-key":
			http.NotFound(w, r)
		case "/v0/management/claude-api-key":
			_, _ = w.Write([]byte(`{"claude-api-key":[]}`))
		case "/v0/management/codex-api-key":
			_, _ = w.Write([]byte(`{"codex-api-key":[]}`))
		case "/v0/management/vertex-api-key":
			_, _ = w.Write([]byte(`{"vertex-api-key":[]}`))
		case "/v0/management/openai-compatibility":
			_, _ = w.Write([]byte(`{"openai-compatibility":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	store, err := sqlite.Open(sqlite.Config{Path: filepath.Join(t.TempDir(), "metadata.db")})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	service := New(cpa.NewClient(server.URL, "secret", time.Second), store, nil)
	if err := service.Sync(context.Background()); err != nil {
		t.Fatalf("Sync with older CPA: %v", err)
	}
}
