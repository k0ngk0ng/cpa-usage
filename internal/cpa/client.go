package cpa

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"
)

// Client wraps the CPA management HTTP API. It is safe for concurrent use.
type Client struct {
	baseURL       string
	managementKey string
	httpClient    *http.Client

	versionMu sync.RWMutex
	version   VersionInfo
}

// VersionInfo holds the most recently observed CPA build metadata, captured
// from the X-CPA-VERSION / X-CPA-COMMIT / X-CPA-BUILD-DATE headers that CPA
// stamps on every management response.
type VersionInfo struct {
	Version   string
	Commit    string
	BuildDate string
}

// RequestLogMeta describes a request log downloaded from CPA's management
// endpoint. Size is the number of bytes copied into the caller's writer.
type RequestLogMeta struct {
	FileName string
	Size     int64
}

// RequestLogDownloader is implemented by Client and kept as an interface so
// API handlers can be tested without a live CPA process.
type RequestLogDownloader interface {
	DownloadRequestLog(ctx context.Context, requestID string, dst io.Writer) (RequestLogMeta, error)
}

// RequestLogRangeDownloader is the optional ranged-download capability used
// for lazy inline assets, avoiding a full log transfer for every image or file.
type RequestLogRangeDownloader interface {
	DownloadRequestLogRange(ctx context.Context, requestID string, offset, length int64, dst io.Writer) (RequestLogMeta, error)
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

// Version returns the most recently observed CPA build metadata. Empty fields
// mean we haven't successfully called a management endpoint yet.
func (c *Client) Version() VersionInfo {
	c.versionMu.RLock()
	defer c.versionMu.RUnlock()
	return c.version
}

func (c *Client) recordVersion(h http.Header) {
	v := VersionInfo{
		Version:   strings.TrimSpace(h.Get("X-CPA-VERSION")),
		Commit:    strings.TrimSpace(h.Get("X-CPA-COMMIT")),
		BuildDate: strings.TrimSpace(h.Get("X-CPA-BUILD-DATE")),
	}
	if v == (VersionInfo{}) {
		return
	}
	c.versionMu.Lock()
	c.version = v
	c.versionMu.Unlock()
}

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

// FetchInteractionsKeys returns the native Google Interactions provider catalog.
func (c *Client) FetchInteractionsKeys(ctx context.Context) ([]ProviderKeyConfig, error) {
	return c.fetchProviderKeyConfig(ctx, managementInteractionsEndpoint, "interactions-api-key")
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

// DownloadRequestLog fetches the raw per-request log through CPA's management
// API. This is the fallback for deployments where cpa-usage does not share the
// CPA log directory.
func (c *Client) DownloadRequestLog(ctx context.Context, requestID string, dst io.Writer) (RequestLogMeta, error) {
	return c.downloadRequestLog(ctx, requestID, 0, 0, dst)
}

// DownloadRequestLogRange fetches exactly one byte range from a CPA request
// log. It also tolerates older servers that ignore Range and return status 200.
func (c *Client) DownloadRequestLogRange(ctx context.Context, requestID string, offset, length int64, dst io.Writer) (RequestLogMeta, error) {
	if offset < 0 || length <= 0 || length > math.MaxInt64-offset {
		return RequestLogMeta{}, fmt.Errorf("invalid request log range")
	}
	return c.downloadRequestLog(ctx, requestID, offset, length, dst)
}

func (c *Client) downloadRequestLog(ctx context.Context, requestID string, offset, length int64, dst io.Writer) (RequestLogMeta, error) {
	if c == nil || c.baseURL == "" {
		return RequestLogMeta{}, fmt.Errorf("cpa client is not configured")
	}
	if c.managementKey == "" {
		return RequestLogMeta{}, fmt.Errorf("cpa management key is required")
	}
	if dst == nil {
		return RequestLogMeta{}, fmt.Errorf("request log destination is required")
	}
	if err := ValidateRequestID(requestID); err != nil {
		return RequestLogMeta{}, err
	}

	requestPath := managementRequestLogEndpoint + url.PathEscape(requestID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+requestPath, nil)
	if err != nil {
		return RequestLogMeta{}, fmt.Errorf("build request %s: %w", requestPath, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.managementKey)
	if length > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, offset+length-1))
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return RequestLogMeta{}, fmt.Errorf("request %s: %w", requestPath, err)
	}
	defer resp.Body.Close()
	c.recordVersion(resp.Header)

	if resp.StatusCode == http.StatusNotFound {
		return RequestLogMeta{}, ErrLogNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return RequestLogMeta{}, fmt.Errorf("%s returned status %d", requestPath, resp.StatusCode)
	}

	var written int64
	if length <= 0 {
		written, err = io.Copy(dst, resp.Body)
	} else {
		if resp.StatusCode == http.StatusOK && offset > 0 {
			if _, err = io.CopyN(io.Discard, resp.Body, offset); err != nil {
				return RequestLogMeta{}, fmt.Errorf("skip %s body to range start: %w", requestPath, err)
			}
		}
		written, err = io.CopyN(dst, resp.Body, length)
	}
	if err != nil {
		return RequestLogMeta{}, fmt.Errorf("read %s body: %w", requestPath, err)
	}
	return RequestLogMeta{
		FileName: requestLogFileName(resp.Header, requestID),
		Size:     written,
	}, nil
}

func requestLogFileName(header http.Header, requestID string) string {
	if _, params, err := mime.ParseMediaType(header.Get("Content-Disposition")); err == nil {
		name := strings.TrimSpace(params["filename"])
		name = path.Base(strings.ReplaceAll(name, `\`, "/"))
		if name != "" && name != "." && name != "/" {
			return name
		}
	}
	return "request-log-" + requestID + ".log"
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
	c.recordVersion(resp.Header)
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
