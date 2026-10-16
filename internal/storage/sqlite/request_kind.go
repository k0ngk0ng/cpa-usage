package sqlite

import (
	"context"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"gorm.io/gorm/clause"
)

type requestKindModel struct {
	RequestID string `gorm:"primaryKey;column:request_id"`
	Kind      string
	Complete  bool
	CheckedAt time.Time
}

func (requestKindModel) TableName() string { return "request_log_kinds" }

func (s *Store) RequestKinds(ctx context.Context, ids []string) (map[string]storage.RequestKind, error) {
	out := make(map[string]storage.RequestKind)
	if len(ids) == 0 {
		return out, nil
	}
	var rows []storage.RequestKind
	// Deduplicate log lookups without merging usage records, and restrict
	// discovery to logs actually referenced by retained usage.
	err := s.dbCtx(ctx).Table("usage_events AS e").
		Select("e.request_id, COALESCE(k.kind, 'unknown') AS kind, k.complete, k.checked_at").
		Joins("LEFT JOIN request_log_kinds AS k ON k.request_id = e.request_id").
		Where("e.request_id IN ?", ids).Group("e.request_id").Scan(&rows).Error
	for _, row := range rows {
		out[row.RequestID] = row
	}
	return out, err
}

func (s *Store) SaveRequestKind(ctx context.Context, kind storage.RequestKind) error {
	row := requestKindModel{RequestID: kind.RequestID, Kind: kind.Kind, Complete: kind.Complete, CheckedAt: time.Now().UTC()}
	// Missing or truncated rereads must not erase captured positive evidence.
	return s.dbCtx(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "request_id"}}, DoUpdates: clause.Assignments(map[string]any{
		"kind":       clause.Expr{SQL: "CASE WHEN request_log_kinds.kind = 'contains_compact' THEN request_log_kinds.kind WHEN excluded.kind = 'contains_compact' THEN excluded.kind WHEN request_log_kinds.kind = 'compact' OR excluded.kind = 'unknown' THEN request_log_kinds.kind ELSE excluded.kind END"},
		"complete":   clause.Expr{SQL: "request_log_kinds.complete OR excluded.complete"},
		"checked_at": row.CheckedAt,
	})}).Create(&row).Error
}
