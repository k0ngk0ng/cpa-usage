package cpa

import (
	"encoding/json"
	"fmt"
	"time"
)

// Endpoints used against the CPA management API.
const (
	managementAuthFilesEndpoint    = "/v0/management/auth-files"
	managementExternalKeysEndpoint = "/v0/management/api-keys"
	managementGeminiKeysEndpoint   = "/v0/management/gemini-api-key"
	managementInteractionsEndpoint = "/v0/management/interactions-api-key"
	managementClaudeKeysEndpoint   = "/v0/management/claude-api-key"
	managementCodexKeysEndpoint    = "/v0/management/codex-api-key"
	managementVertexKeysEndpoint   = "/v0/management/vertex-api-key"
	managementOpenAICompatEndpoint = "/v0/management/openai-compatibility"
	managementRequestLogEndpoint   = "/v0/management/request-log-by-id/"
	modelsEndpoint                 = "/v1/models"

	// Redis queue (RESP TCP) constants — multiplexed on CPA's HTTP port (8317 by default).
	redisNetwork          = "tcp"
	RedisDefaultPort      = "8317"
	RedisAuthCommand      = "AUTH"
	RedisLPopCommand      = "LPOP"
	RedisSubscribeCommand = "SUBSCRIBE"
	RedisUsageQueueKey    = "usage"
)

// AuthFile mirrors a single entry from /v0/management/auth-files.
type AuthFile struct {
	AuthIndex   string `json:"auth_index"`
	Name        string `json:"name"`
	Email       string `json:"email"`
	Type        string `json:"type"`
	Provider    string `json:"provider"`
	Label       string `json:"label"`
	Status      string `json:"status"`
	Source      string `json:"source"`
	Disabled    bool   `json:"disabled"`
	Unavailable bool   `json:"unavailable"`
	RuntimeOnly bool   `json:"runtime_only"`
}

// AuthFilesResponse is the envelope returned by the auth-files endpoint.
type AuthFilesResponse struct {
	Files []AuthFile `json:"files"`
}

// ExternalKeysResponse is the envelope for the /api-keys endpoint.
type ExternalKeysResponse struct {
	Keys []string `json:"api-keys"`
}

// ModelsResponse is the OpenAI-style response from /v1/models.
type ModelsResponse struct {
	Object string      `json:"object"`
	Data   []ModelInfo `json:"data"`
}

// ModelInfo is one entry in the /v1/models response.
type ModelInfo struct {
	ID      string `json:"id"`
	Object  string `json:"object,omitempty"`
	Created int64  `json:"created,omitempty"`
	OwnedBy string `json:"owned_by,omitempty"`
}

// ProviderKeyConfig is a flexible decoding wrapper around a per-provider key entry.
type ProviderKeyConfig struct {
	APIKey string
	Prefix string
	Name   string
}

// UnmarshalJSON tolerates either map-style or partial-map encodings.
func (p *ProviderKeyConfig) UnmarshalJSON(data []byte) error {
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("decode provider key config: %w", err)
	}
	p.APIKey = firstString(raw, "apiKey", "api-key", "key")
	p.Prefix = firstString(raw, "prefix")
	p.Name = firstString(raw, "name")
	return nil
}

// OpenAICompatibilityConfig is a /openai-compatibility entry with N keys.
type OpenAICompatibilityConfig struct {
	Name          string
	Prefix        string
	APIKeyEntries []OpenAIApiKeyEntry
}

// OpenAIApiKeyEntry tolerates string-or-object encodings.
type OpenAIApiKeyEntry struct {
	APIKey string
}

func (c *OpenAICompatibilityConfig) UnmarshalJSON(data []byte) error {
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("decode openai compatibility config: %w", err)
	}
	c.Name = firstString(raw, "name", "id")
	c.Prefix = firstString(raw, "prefix")
	for _, key := range []string{"apiKeyEntries", "api-key-entries", "api-keys"} {
		v, ok := raw[key]
		if !ok {
			continue
		}
		entries, err := decodeOpenAIKeyEntries(v)
		if err != nil {
			return err
		}
		c.APIKeyEntries = entries
		break
	}
	return nil
}

func (e *OpenAIApiKeyEntry) UnmarshalJSON(data []byte) error {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("decode openai api key entry: %w", err)
	}
	entry, err := decodeOpenAIKeyEntry(raw)
	if err != nil {
		return err
	}
	*e = entry
	return nil
}

func decodeOpenAIKeyEntries(value any) ([]OpenAIApiKeyEntry, error) {
	rawEntries, ok := value.([]any)
	if !ok {
		return nil, nil
	}
	out := make([]OpenAIApiKeyEntry, 0, len(rawEntries))
	for _, raw := range rawEntries {
		entry, err := decodeOpenAIKeyEntry(raw)
		if err != nil {
			return nil, err
		}
		if entry.APIKey == "" {
			continue
		}
		out = append(out, entry)
	}
	return out, nil
}

func decodeOpenAIKeyEntry(raw any) (OpenAIApiKeyEntry, error) {
	switch v := raw.(type) {
	case string:
		return OpenAIApiKeyEntry{APIKey: v}, nil
	case map[string]any:
		return OpenAIApiKeyEntry{APIKey: firstString(v, "apiKey", "api-key", "key")}, nil
	case nil:
		return OpenAIApiKeyEntry{}, nil
	default:
		return OpenAIApiKeyEntry{}, fmt.Errorf("unsupported openai key entry %T", raw)
	}
}

func firstString(raw map[string]any, keys ...string) string {
	for _, key := range keys {
		v, ok := raw[key]
		if !ok || v == nil {
			continue
		}
		s, ok := v.(string)
		if !ok || s == "" {
			continue
		}
		return s
	}
	return ""
}

// UsageRecord is the shape of one JSON message produced by CPA on the usage queue.
// CPA encodes timestamps as RFC3339 strings; deserialization tolerates both string
// and object container shapes via Tokens.
type UsageRecord struct {
	Timestamp           time.Time       `json:"timestamp"`
	LatencyMs           int64           `json:"latency_ms"`
	TTFTMs              int64           `json:"ttft_ms"`
	Source              string          `json:"source"`
	AuthIndex           string          `json:"auth_index"`
	Tokens              UsageTokens     `json:"tokens"`
	Failed              bool            `json:"failed"`
	Fail                UsageFail       `json:"fail"`
	ResponseHeaders     json.RawMessage `json:"response_headers"`
	Provider            string          `json:"provider"`
	ExecutorType        string          `json:"executor_type"`
	Model               string          `json:"model"`
	Alias               string          `json:"alias"`
	Endpoint            string          `json:"endpoint"`
	AuthType            string          `json:"auth_type"`
	APIKey              string          `json:"api_key"`
	RequestID           string          `json:"request_id"`
	ReasoningEffort     string          `json:"reasoning_effort"`
	ServiceTier         string          `json:"service_tier"`
	RequestServiceTier  string          `json:"request_service_tier"`
	ResponseServiceTier string          `json:"response_service_tier"`
}

// UsageTokens is the nested token stats object from CPA.
type UsageTokens struct {
	InputTokens         int64 `json:"input_tokens"`
	OutputTokens        int64 `json:"output_tokens"`
	ReasoningTokens     int64 `json:"reasoning_tokens"`
	CachedTokens        int64 `json:"cached_tokens"`
	CacheReadTokens     int64 `json:"cache_read_tokens"`
	CacheCreationTokens int64 `json:"cache_creation_tokens"`
	TotalTokens         int64 `json:"total_tokens"`
}

// UsageFail is the nested failure detail object from CPA.
type UsageFail struct {
	StatusCode int    `json:"status_code"`
	Body       string `json:"body"`
}
