package cpa

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client wraps the CPA management HTTP API. It is safe for concurrent use.
type Client struct {
	baseURL       string
	managementKey string
	httpClient    *http.Client
}

// NewClient builds a Client for the given CPA base URL and management key.
func NewClient(baseURL, managementKey string, timeout time.Duration) *Client {
	return &Client{
		baseURL:       strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		managementKey: strings.TrimSpace(managementKey),
		httpClient:    &http.Client{Timeout: timeout},
	}
}

// BaseURL exposes the CPA base URL (used by callers that derive the redis address).
func (c *Client) BaseURL() string { return c.baseURL }

// FetchAuthFiles returns the management auth-files snapshot.
func (c *Client) FetchAuthFiles(ctx context.Context) ([]AuthFile, error) {
	var resp AuthFilesResponse
	if err := c.getManagement(ctx, managementAuthFilesEndpoint, &resp); err != nil {
		return nil, err
	}
	return resp.Files, nil
}

// FetchExternalKeys returns the configured external API keys (used to query /v1/models).
func (c *Client) FetchExternalKeys(ctx context.Context) ([]string, error) {
	var resp ExternalKeysResponse
	if err := c.getManagement(ctx, managementExternalKeysEndpoint, &resp); err != nil {
		return nil, err
	}
	return resp.Keys, nil
}

// FetchModels returns the OpenAI-style /v1/models response, using an external key for auth.
func (c *Client) FetchModels(ctx context.Context) ([]ModelInfo, error) {
	keys, err := c.FetchExternalKeys(ctx)
	if err != nil {
		return nil, err
	}
	apiKey := firstNonEmpty(keys)
	if apiKey == "" {
		return nil, fmt.Errorf("cpa external api keys are required")
	}
	var resp ModelsResponse
	if err := c.getJSON(ctx, modelsEndpoint, &resp, func(req *http.Request) {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

// FetchGeminiKeys returns the gemini provider catalog.
func (c *Client) FetchGeminiKeys(ctx context.Context) ([]ProviderKeyConfig, error) {
	return c.fetchProviderKeyConfig(ctx, managementGeminiKeysEndpoint, "gemini-api-key")
}

// FetchClaudeKeys returns the claude provider catalog.
func (c *Client) FetchClaudeKeys(ctx context.Context) ([]ProviderKeyConfig, error) {
	return c.fetchProviderKeyConfig(ctx, managementClaudeKeysEndpoint, "claude-api-key")
}

// FetchCodexKeys returns the codex provider catalog.
func (c *Client) FetchCodexKeys(ctx context.Context) ([]ProviderKeyConfig, error) {
	return c.fetchProviderKeyConfig(ctx, managementCodexKeysEndpoint, "codex-api-key")
}

// FetchVertexKeys returns the vertex provider catalog.
func (c *Client) FetchVertexKeys(ctx context.Context) ([]ProviderKeyConfig, error) {
	return c.fetchProviderKeyConfig(ctx, managementVertexKeysEndpoint, "vertex-api-key")
}

// FetchOpenAICompatibility returns the openai-compatible provider catalog.
func (c *Client) FetchOpenAICompatibility(ctx context.Context) ([]OpenAICompatibilityConfig, error) {
	resp := map[string][]OpenAICompatibilityConfig{}
	if err := c.getManagement(ctx, managementOpenAICompatEndpoint, &resp); err != nil {
		return nil, err
	}
	return resp["openai-compatibility"], nil
}

func (c *Client) fetchProviderKeyConfig(ctx context.Context, path, envelopeKey string) ([]ProviderKeyConfig, error) {
	resp := map[string][]ProviderKeyConfig{}
	if err := c.getManagement(ctx, path, &resp); err != nil {
		return nil, err
	}
	return resp[envelopeKey], nil
}

func (c *Client) getManagement(ctx context.Context, path string, target any) error {
	if c == nil || c.baseURL == "" {
		return fmt.Errorf("cpa client is not configured")
	}
	if c.managementKey == "" {
		return fmt.Errorf("cpa management key is required")
	}
	return c.getJSON(ctx, path, target, func(req *http.Request) {
		req.Header.Set("Authorization", "Bearer "+c.managementKey)
	})
}

func (c *Client) getJSON(ctx context.Context, path string, target any, configure func(*http.Request)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return fmt.Errorf("build request %s: %w", path, err)
	}
	if configure != nil {
		configure(req)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read %s body: %w", path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s returned status %d", path, resp.StatusCode)
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("decode %s json: %w", path, err)
	}
	return nil
}

func firstNonEmpty(values []string) string {
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v != "" {
			return v
		}
	}
	return ""
}
