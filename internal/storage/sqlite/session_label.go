package sqlite

import (
	"context"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"gorm.io/gorm/clause"
)

type requestLabelModel struct {
	RequestID string `gorm:"primaryKey;column:request_id"`
	Title     string
	Source    string
	Complete  bool
	CheckedAt time.Time
}

func (requestLabelModel) TableName() string { return "request_log_labels" }

func (s *Store) SessionLabel(ctx context.Context, sessionID string) (storage.SessionLabel, error) {
	var out storage.SessionLabel
	// Rank real naming responses before previews; prefer the latest title and
	// earliest retained input. A log only labels sessions explicitly using it.
	err := s.dbCtx(ctx).Table("request_log_labels AS l").Select("l.title, l.source, l.request_id").
		Joins("JOIN usage_events AS e ON e.request_id = l.request_id").
		Where("e.session_id = ? AND l.title <> ''", sessionID).Group("l.request_id").
		Order("CASE WHEN l.source = 'generated_title' THEN 0 ELSE 1 END").
		Order("CASE WHEN l.source = 'generated_title' THEN MAX(e.timestamp) END DESC").
		Order("MIN(e.timestamp) ASC, l.request_id ASC").Limit(1).Scan(&out).Error
	return out, err
}

func (s *Store) SessionLabelCandidates(ctx context.Context, sessionID string) ([]string, error) {
	query := func(order string) ([]string, error) {
		var ids []string
		err := s.dbCtx(ctx).Table("usage_events AS e").Select("e.request_id").
			Joins("LEFT JOIN request_log_labels AS l ON e.request_id = l.request_id").
			Where("e.session_id = ? AND COALESCE(e.request_id, '') <> ''", sessionID).
			Where("l.request_id IS NULL OR (l.complete = ? AND l.checked_at < ?)", false, time.Now().UTC().Add(-5*time.Minute)).
			Group("e.request_id").Order("MIN(e.timestamp) "+order).Order("e.request_id "+order).Limit(8).Pluck("e.request_id", &ids).Error
		return ids, err
	}
	oldest, err := query("ASC")
	if err != nil {
		return nil, err
	}
	newest, err := query("DESC")
	if err != nil {
		return nil, err
	}
	// Start with early conversation context, then recent naming/rename calls.
	ids := make([]string, 0, 8)
	seen := map[string]bool{}
	add := func(id string) {
		if !seen[id] && len(ids) < 8 {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for i, id := range oldest {
		if i < 2 {
			add(id)
		}
	}
	for _, id := range newest {
		add(id)
	}
	return ids, nil
}

func (s *Store) SaveRequestLabel(ctx context.Context, label storage.RequestLabel) error {
	row := requestLabelModel{RequestID: label.RequestID, Title: label.Title, Source: label.Source, Complete: label.Complete, CheckedAt: time.Now().UTC()}
	// An unavailable/truncated reread must not erase already captured evidence.
	return s.dbCtx(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "request_id"}}, DoUpdates: clause.Assignments(map[string]any{
		"title":      clause.Expr{SQL: "CASE WHEN excluded.title <> '' AND (request_log_labels.source <> 'generated_title' OR excluded.source = 'generated_title') THEN excluded.title ELSE request_log_labels.title END"},
		"source":     clause.Expr{SQL: "CASE WHEN excluded.title <> '' AND (request_log_labels.source <> 'generated_title' OR excluded.source = 'generated_title') THEN excluded.source ELSE request_log_labels.source END"},
		"complete":   clause.Expr{SQL: "request_log_labels.complete OR excluded.complete"},
		"checked_at": row.CheckedAt,
	})}).Create(&row).Error
}
