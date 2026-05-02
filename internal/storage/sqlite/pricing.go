package sqlite

import (
	"context"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm/clause"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// ListUsedModels returns the distinct, non-empty models observed in usage_events.
func (s *Store) ListUsedModels(ctx context.Context) ([]string, error) {
	var models []string
	err := s.dbCtx(ctx).
		Model(&usageEventModel{}).
		Distinct("model").
		Where("model <> ''").
		Order("model").
		Pluck("model", &models).Error
	if err != nil {
		return nil, err
	}
	return models, nil
}

// ListPricing returns all configured per-model prices.
func (s *Store) ListPricing(ctx context.Context) ([]storage.ModelPriceSetting, error) {
	var rows []modelPriceSettingModel
	if err := s.dbCtx(ctx).Order("model").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]storage.ModelPriceSetting, 0, len(rows))
	for _, r := range rows {
		out = append(out, storage.ModelPriceSetting{
			Model:                r.Model,
			PromptPricePer1M:     r.PromptPricePer1M,
			CompletionPricePer1M: r.CompletionPricePer1M,
			CachePricePer1M:      r.CachePricePer1M,
			UpdatedAt:            r.UpdatedAt,
		})
	}
	return out, nil
}

// UpsertPricing inserts or updates a per-model price entry, keyed on model name.
func (s *Store) UpsertPricing(ctx context.Context, p storage.ModelPriceSetting) error {
	model := strings.TrimSpace(p.Model)
	if model == "" {
		return errors.New("model is required")
	}
	row := modelPriceSettingModel{
		Model:                model,
		PromptPricePer1M:     p.PromptPricePer1M,
		CompletionPricePer1M: p.CompletionPricePer1M,
		CachePricePer1M:      p.CachePricePer1M,
		UpdatedAt:            time.Now().UTC(),
	}
	return s.dbCtx(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "model"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"prompt_price_per_1m",
				"completion_price_per_1m",
				"cache_price_per_1m",
				"updated_at",
			}),
		}).
		Create(&row).Error
}

// DeletePricing removes the pricing row for the supplied model.
func (s *Store) DeletePricing(ctx context.Context, model string) error {
	model = strings.TrimSpace(model)
	if model == "" {
		return errors.New("model is required")
	}
	return s.dbCtx(ctx).
		Where("model = ?", model).
		Delete(&modelPriceSettingModel{}).Error
}
