package sqlite

import (
	"context"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"gorm.io/gorm/clause"
)

type requestKindModel struct {
	RequestID         string `gorm:"primaryKey;column:request_id"`
	Kind              string
	Complete          bool
	CheckedAt         time.Time
	ClassifierVersion int `gorm:"not null;default:0"`
}

const requestKindClassifierVersion = 1

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
		Joins("LEFT JOIN request_log_kinds AS k ON k.request_id = e.request_id AND (k.classifier_version = ? OR k.kind IN ('compact', 'contains_compact'))", requestKindClassifierVersion).
		Where("e.request_id IN ?", ids).Group("e.request_id").Scan(&rows).Error
	for _, row := range rows {
		out[row.RequestID] = row
	}
	return out, err
}

func (s *Store) SaveRequestKind(ctx context.Context, kind storage.RequestKind) error {
	row := requestKindModel{RequestID: kind.RequestID, Kind: kind.Kind, Complete: kind.Complete, CheckedAt: time.Now().UTC(), ClassifierVersion: requestKindClassifierVersion}
	// Old negative classifications must be rescanned after rules change. An
	// unavailable reread must not promote the stale Normal result to this version.
	const staleNegative = "request_log_kinds.classifier_version <> excluded.classifier_version AND request_log_kinds.kind NOT IN ('compact', 'contains_compact')"
	// Missing or truncated rereads must not erase captured positive evidence.
	return s.dbCtx(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "request_id"}}, DoUpdates: clause.Assignments(map[string]any{
		"kind":               clause.Expr{SQL: "CASE WHEN " + staleNegative + " THEN excluded.kind WHEN request_log_kinds.kind = 'contains_compact' THEN request_log_kinds.kind WHEN excluded.kind = 'contains_compact' THEN excluded.kind WHEN request_log_kinds.kind = 'compact' OR excluded.kind = 'unknown' THEN request_log_kinds.kind ELSE excluded.kind END"},
		"complete":           clause.Expr{SQL: "CASE WHEN " + staleNegative + " THEN excluded.complete ELSE request_log_kinds.complete OR excluded.complete END"},
		"checked_at":         row.CheckedAt,
		"classifier_version": row.ClassifierVersion,
	})}).Create(&row).Error
}
