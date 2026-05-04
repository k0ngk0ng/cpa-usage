package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// ListAPIKeyAliases returns every alias row, ordered by api_key.
func (s *Store) ListAPIKeyAliases(ctx context.Context) ([]storage.APIKeyAlias, error) {
	var rows []apiKeyAliasModel
	if err := s.dbCtx(ctx).Order("api_key").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]storage.APIKeyAlias, 0, len(rows))
	for _, r := range rows {
		out = append(out, storage.APIKeyAlias{
			APIKey:    r.APIKey,
			Alias:     r.Alias,
			UpdatedAt: r.UpdatedAt,
		})
	}
	return out, nil
}

// ListAPIKeyOverview returns one row per distinct api_key observed in
// usage_events left-joined with its alias (if any). Empty api_key values
// are excluded — they show up as "unknown" in the existing display flow
// and don't make sense to alias individually.
func (s *Store) ListAPIKeyOverview(ctx context.Context) ([]storage.APIKeyOverview, error) {
	type row struct {
		APIKey         string
		Alias          string
		EventCount     int64
		AliasUpdatedAt sql.NullTime
	}
	var rows []row
	// LEFT JOIN preserves observed api_keys without an alias; aliases that
	// have no corresponding events are picked up by a UNION via the
	// fallback branch below.
	err := s.dbCtx(ctx).
		Table("usage_events AS e").
		Select(`
			e.api_key AS api_key,
			COALESCE(a.alias, '') AS alias,
			COUNT(*) AS event_count,
			a.updated_at AS alias_updated_at
		`).
		Joins("LEFT JOIN api_key_aliases AS a ON a.api_key = e.api_key").
		Where("e.api_key <> ''").
		Group("e.api_key").
		Order("event_count DESC, e.api_key ASC").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(rows))
	out := make([]storage.APIKeyOverview, 0, len(rows))
	for _, r := range rows {
		seen[r.APIKey] = struct{}{}
		var ts time.Time
		if r.AliasUpdatedAt.Valid {
			ts = r.AliasUpdatedAt.Time
		}
		out = append(out, storage.APIKeyOverview{
			APIKey:         r.APIKey,
			Alias:          r.Alias,
			EventCount:     r.EventCount,
			AliasUpdatedAt: ts,
		})
	}
	// Append aliases for keys that have no events yet (manually added via
	// import or PUT before any traffic was seen) so they are still
	// editable from the UI.
	var orphan []apiKeyAliasModel
	if err := s.dbCtx(ctx).Order("api_key").Find(&orphan).Error; err != nil {
		return nil, err
	}
	for _, o := range orphan {
		if _, ok := seen[o.APIKey]; ok {
			continue
		}
		out = append(out, storage.APIKeyOverview{
			APIKey:         o.APIKey,
			Alias:          o.Alias,
			EventCount:     0,
			AliasUpdatedAt: o.UpdatedAt,
		})
	}
	return out, nil
}

// UpsertAPIKeyAlias inserts or updates an alias keyed on api_key. An empty
// alias deletes the row instead of writing a blank — operators clearing the
// alias field in the UI expect the alias to disappear, not to persist as "".
func (s *Store) UpsertAPIKeyAlias(ctx context.Context, alias storage.APIKeyAlias) error {
	apiKey := strings.TrimSpace(alias.APIKey)
	if apiKey == "" {
		return errors.New("api_key is required")
	}
	value := strings.TrimSpace(alias.Alias)
	if value == "" {
		return s.DeleteAPIKeyAlias(ctx, apiKey)
	}
	row := apiKeyAliasModel{
		APIKey:    apiKey,
		Alias:     value,
		UpdatedAt: time.Now().UTC(),
	}
	return s.dbCtx(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "api_key"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"alias",
				"updated_at",
			}),
		}).
		Create(&row).Error
}

// DeleteAPIKeyAlias removes the alias for the supplied api_key.
func (s *Store) DeleteAPIKeyAlias(ctx context.Context, apiKey string) error {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return errors.New("api_key is required")
	}
	return s.dbCtx(ctx).
		Where("api_key = ?", apiKey).
		Delete(&apiKeyAliasModel{}).Error
}

// ReplaceAPIKeyAliases truncates the alias table and bulk-inserts the
// supplied entries inside a single transaction, so an import-as-replace
// either commits in full or leaves the previous state untouched.
func (s *Store) ReplaceAPIKeyAliases(ctx context.Context, items []storage.APIKeyAlias) error {
	now := time.Now().UTC()
	rows := make([]apiKeyAliasModel, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, it := range items {
		apiKey := strings.TrimSpace(it.APIKey)
		alias := strings.TrimSpace(it.Alias)
		if apiKey == "" || alias == "" {
			continue
		}
		if _, dup := seen[apiKey]; dup {
			continue
		}
		seen[apiKey] = struct{}{}
		ts := it.UpdatedAt
		if ts.IsZero() {
			ts = now
		}
		rows = append(rows, apiKeyAliasModel{
			APIKey:    apiKey,
			Alias:     alias,
			UpdatedAt: ts,
		})
	}
	return s.dbCtx(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("1 = 1").Delete(&apiKeyAliasModel{}).Error; err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		return tx.Create(&rows).Error
	})
}
