// Package pricing exposes per-model price-per-1M-token configuration.
// Prices are persisted via storage.Store and cached in memory for quick lookup
// during usage cost computation.
package pricing

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// Service caches the pricing catalog, refreshing on every write.
type Service struct {
	store storage.Store

	mu     sync.RWMutex
	prices map[string]storage.ModelPriceSetting
}

// New constructs a pricing Service backed by the supplied store.
func New(store storage.Store) *Service {
	return &Service{
		store:  store,
		prices: make(map[string]storage.ModelPriceSetting),
	}
}

// Reload pulls the latest prices from storage into the in-memory cache.
func (s *Service) Reload(ctx context.Context) error {
	rows, err := s.store.ListPricing(ctx)
	if err != nil {
		return err
	}
	cache := make(map[string]storage.ModelPriceSetting, len(rows))
	for _, r := range rows {
		r.CacheWritePricePer1M = clonePricePtr(r.CacheWritePricePer1M)
		cache[r.Model] = r
	}
	s.mu.Lock()
	s.prices = cache
	s.mu.Unlock()
	return nil
}

// Snapshot returns a defensive copy of the current price map.
// Callers can pass this directly into storage methods.
func (s *Service) Snapshot() map[string]storage.ModelPriceSetting {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]storage.ModelPriceSetting, len(s.prices))
	for k, v := range s.prices {
		v.CacheWritePricePer1M = clonePricePtr(v.CacheWritePricePer1M)
		out[k] = v
	}
	return out
}

func clonePricePtr(value *float64) *float64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

// List returns prices ordered by model name (UI-friendly).
func (s *Service) List(ctx context.Context) ([]storage.ModelPriceSetting, error) {
	return s.store.ListPricing(ctx)
}

// Upsert persists a price entry and refreshes the in-memory cache.
func (s *Service) Upsert(ctx context.Context, p storage.ModelPriceSetting) error {
	p.Model = strings.TrimSpace(p.Model)
	if p.Model == "" {
		return errors.New("model is required")
	}
	if p.PromptPricePer1M < 0 || p.CompletionPricePer1M < 0 || p.CachePricePer1M < 0 ||
		(p.CacheWritePricePer1M != nil && *p.CacheWritePricePer1M < 0) {
		return errors.New("price must be non-negative")
	}
	p.UpdatedAt = time.Now().UTC()
	if err := s.store.UpsertPricing(ctx, p); err != nil {
		return err
	}
	return s.Reload(ctx)
}

// Delete removes a price entry and refreshes the in-memory cache.
func (s *Service) Delete(ctx context.Context, model string) error {
	if err := s.store.DeletePricing(ctx, model); err != nil {
		return err
	}
	return s.Reload(ctx)
}
