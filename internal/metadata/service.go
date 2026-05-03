// Package metadata orchestrates periodic refreshes of the CPA management
// catalog (auth-files, provider keys, openai-compatibility) into the local
// storage cache. The cached snapshots back the /auth-files and
// /provider-metadata API endpoints so the UI doesn't hit CPA on every request.
package metadata

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// Service refreshes auth-files + provider catalog snapshots from CPA.
type Service struct {
	client *cpa.Client
	store  storage.Store
	logger *logrus.Logger

	mu         sync.Mutex
	lastSyncAt time.Time
	lastError  string
}

// New constructs a metadata Service.
func New(client *cpa.Client, store storage.Store, logger *logrus.Logger) *Service {
	if logger == nil {
		logger = logrus.New()
	}
	return &Service{client: client, store: store, logger: logger}
}

// LastSyncAt returns the most recent successful sync timestamp.
func (s *Service) LastSyncAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastSyncAt
}

// LastError returns the most recent sync error (empty if last run was OK).
func (s *Service) LastError() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastError
}

// Sync runs a single refresh pass. It tolerates partial failures: if one CPA
// endpoint fails, the others still update, and the aggregated error is logged.
func (s *Service) Sync(ctx context.Context) error {
	if s == nil || s.client == nil {
		return nil
	}
	var firstErr error
	mark := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}

	if files, err := s.client.FetchAuthFiles(ctx); err != nil {
		mark(fmt.Errorf("fetch auth files: %w", err))
		s.logger.WithError(err).Warn("metadata: fetch auth files failed")
	} else {
		converted := make([]storage.AuthFile, 0, len(files))
		for _, f := range files {
			if strings.TrimSpace(f.AuthIndex) == "" {
				continue
			}
			converted = append(converted, storage.AuthFile{
				AuthIndex:   strings.TrimSpace(f.AuthIndex),
				Name:        strings.TrimSpace(f.Name),
				Email:       strings.TrimSpace(f.Email),
				Type:        strings.TrimSpace(f.Type),
				Provider:    strings.TrimSpace(f.Provider),
				Label:       strings.TrimSpace(f.Label),
				Status:      strings.TrimSpace(f.Status),
				Source:      strings.TrimSpace(f.Source),
				Disabled:    f.Disabled,
				Unavailable: f.Unavailable,
				RuntimeOnly: f.RuntimeOnly,
			})
		}
		if err := s.store.ReplaceAuthFiles(ctx, converted); err != nil {
			mark(fmt.Errorf("replace auth files: %w", err))
		}
	}

	if items, err := s.collectProviderMetadata(ctx); err != nil {
		mark(err)
	} else if err := s.store.ReplaceProviderMetadata(ctx, items); err != nil {
		mark(fmt.Errorf("replace provider metadata: %w", err))
	}

	s.mu.Lock()
	s.lastSyncAt = time.Now().UTC()
	if firstErr != nil {
		s.lastError = firstErr.Error()
	} else {
		s.lastError = ""
	}
	s.mu.Unlock()
	return firstErr
}

func (s *Service) collectProviderMetadata(ctx context.Context) ([]storage.ProviderMetadata, error) {
	out := make([]storage.ProviderMetadata, 0, 32)
	seen := make(map[string]struct{})
	add := func(item storage.ProviderMetadata) {
		key := item.ProviderType + "|" + item.LookupKey
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}

	type providerFetch struct {
		kind  string
		fetch func(ctx context.Context) ([]cpa.ProviderKeyConfig, error)
	}
	providerFetches := []providerFetch{
		{"gemini", s.client.FetchGeminiKeys},
		{"claude", s.client.FetchClaudeKeys},
		{"codex", s.client.FetchCodexKeys},
		{"vertex", s.client.FetchVertexKeys},
	}

	var firstErr error
	for _, pf := range providerFetches {
		entries, err := pf.fetch(ctx)
		if err != nil {
			s.logger.WithError(err).WithField("kind", pf.kind).Warn("metadata: fetch provider keys failed")
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for _, e := range entries {
			apiKey := strings.TrimSpace(e.APIKey)
			name := strings.TrimSpace(e.Name)
			prefix := strings.TrimSpace(e.Prefix)
			display := name
			if display == "" {
				display = prefix
			}
			if apiKey != "" {
				add(storage.ProviderMetadata{
					LookupKey:    apiKey,
					ProviderType: pf.kind,
					DisplayName:  display,
					ProviderKey:  apiKey,
					MatchKind:    "api_key",
				})
			}
			if prefix != "" {
				add(storage.ProviderMetadata{
					LookupKey:    prefix,
					ProviderType: pf.kind,
					DisplayName:  name,
					ProviderKey:  apiKey,
					MatchKind:    "prefix",
				})
			}
		}
	}

	openAI, err := s.client.FetchOpenAICompatibility(ctx)
	if err != nil {
		s.logger.WithError(err).Warn("metadata: fetch openai compatibility failed")
		if firstErr == nil {
			firstErr = err
		}
	} else {
		for _, cfg := range openAI {
			name := strings.TrimSpace(cfg.Name)
			prefix := strings.TrimSpace(cfg.Prefix)
			display := firstNonEmpty(name, prefix)
			for _, entry := range cfg.APIKeyEntries {
				apiKey := strings.TrimSpace(entry.APIKey)
				if apiKey == "" {
					continue
				}
				add(storage.ProviderMetadata{
					LookupKey:    apiKey,
					ProviderType: "openai-compatibility",
					DisplayName:  display,
					ProviderKey:  apiKey,
					MatchKind:    "api_key",
				})
			}
			if prefix != "" {
				add(storage.ProviderMetadata{
					LookupKey:    prefix,
					ProviderType: "openai-compatibility",
					DisplayName:  display,
					ProviderKey:  "",
					MatchKind:    "prefix",
				})
			}
		}
	}
	return out, firstErr
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}
