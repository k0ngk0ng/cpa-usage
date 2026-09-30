package sqlite

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"gorm.io/gorm"
)

// A namespace keeps anonymous event IDs from colliding with actual request IDs.
// Trace and legacy request IDs intentionally share a namespace for mixed data.
const requestGroupSQL = `CASE WHEN COALESCE(trace_id, '') <> '' THEN 'request:' || trace_id WHEN COALESCE(request_id, '') <> '' THEN 'request:' || request_id ELSE 'event:' || event_key END`
const startMillisSQL = `CAST(ROUND((julianday(timestamp) - 2440587.5) * 86400000) AS INTEGER)`
const timelineDetailSize = 200

func timelineGroupSQL(mode string) string {
	if mode == "session" {
		return `'session:' || session_id`
	}
	return requestGroupSQL
}

func timelineSummarySQL(group string) string {
	return group + ` AS key, MAX(` + startMillisSQL + `) AS last_at_ms, MIN(` + startMillisSQL + `) AS started_at_ms,
 MAX(` + startMillisSQL + ` + MAX(0, latency_ms)) AS ended_at_ms,
 COUNT(*) AS records, SUM(CASE WHEN failed THEN 1 ELSE 0 END) AS failed,
 SUM(total_tokens) AS total_tokens, COUNT(DISTINCT model) AS model_count,
 MIN(model) AS model, COUNT(DISTINCT ` + requestGroupSQL + `) AS request_count`
}

// Filters select groups; the summaries include all retained rows in each group.
// A successful retry or an earlier call is not hidden by a failed-only/time filter.
func (s *Store) ListUsageTimelines(ctx context.Context, f storage.UsageFilter, mode string, p storage.Page) (*storage.TimelinePage, error) {
	if mode != "request" && mode != "session" {
		return nil, errors.New("mode must be request or session")
	}
	if p.Page < 1 {
		p.Page = 1
	}
	if p.PageSize < 1 || p.PageSize > 100 {
		p.PageSize = 20
	}
	group := timelineGroupSQL(mode)
	matched := s.applyFilter(ctx, f)
	if mode == "session" {
		matched = matched.Where("COALESCE(session_id, '') <> ''")
	}
	matched = matched.Select(group).Group(group)
	var total int64
	if err := s.dbCtx(ctx).Table("(?) AS matched", matched).Count(&total).Error; err != nil {
		return nil, err
	}
	rows := make([]storage.TimelineSummary, 0)
	// Paginate by matching activity, then preserve that order while expanding
	// each selected group's complete retained history.
	var keys []struct{ Key string }
	if err := matched.Select(group + " AS key").Order("MAX(timestamp) DESC").Order(group).
		Offset((p.Page - 1) * p.PageSize).Limit(p.PageSize).Scan(&keys).Error; err != nil {
		return nil, err
	}
	if len(keys) > 0 {
		ids := make([]string, len(keys))
		positions := make(map[string]int, len(keys))
		for i, key := range keys {
			ids[i] = key.Key
			positions[key.Key] = i
		}
		complete := s.dbCtx(ctx).Model(&usageEventModel{})
		if mode == "session" {
			sessionIDs := make([]string, len(ids))
			for i, id := range ids {
				sessionIDs[i] = strings.TrimPrefix(id, "session:")
			}
			complete = complete.Where("session_id IN ?", sessionIDs)
		} else {
			complete = complete.Where(group+" IN ?", ids)
		}
		if err := complete.Select(timelineSummarySQL(group)).Group(group).Scan(&rows).Error; err != nil {
			return nil, err
		}
		sort.Slice(rows, func(i, j int) bool { return positions[rows[i].Key] < positions[rows[j].Key] })
	}
	for i := range rows {
		rows[i].Kind = strings.SplitN(rows[i].Key, ":", 2)[0]
	}
	return &storage.TimelinePage{Items: rows, Total: total, Page: p.Page, PageSize: p.PageSize}, nil
}

func timelineSelector(q *gorm.DB, key string) (*gorm.DB, error) {
	kind, id, ok := strings.Cut(key, ":")
	if !ok || id == "" || len(key) > 2048 {
		return nil, fmt.Errorf("invalid timeline key")
	}
	switch kind {
	case "session":
		return q.Where("session_id = ?", id), nil
	case "request":
		return q.Where("trace_id = ? OR (COALESCE(trace_id, '') = '' AND request_id = ?)", id, id), nil
	case "event":
		return q.Where("event_key = ? AND COALESCE(trace_id, '') = '' AND COALESCE(request_id, '') = ''", id), nil
	default:
		return nil, fmt.Errorf("invalid timeline key kind")
	}
}

func (s *Store) UsageTimelineDetail(ctx context.Context, key string, cursor, snapshot uint64, prices map[string]storage.ModelPriceSetting) (*storage.TimelineDetail, error) {
	if cursor > 0 && (snapshot == 0 || cursor > snapshot) {
		return nil, errors.New("invalid timeline cursor")
	}
	query := func() *gorm.DB { q, _ := timelineSelector(s.dbCtx(ctx).Model(&usageEventModel{}), key); return q }
	if _, err := timelineSelector(s.dbCtx(ctx).Model(&usageEventModel{}), key); err != nil {
		return nil, err
	}
	if snapshot == 0 {
		if err := query().Select("COALESCE(MAX(id), 0)").Scan(&snapshot).Error; err != nil {
			return nil, err
		}
	}
	var summary storage.TimelineSummary
	// Use a constant bound parameter for the key, never interpolate user text into SQL.
	selectSQL := timelineSummarySQL("?")
	if err := query().Where("id <= ?", snapshot).Select(selectSQL, key).Scan(&summary).Error; err != nil {
		return nil, err
	}
	summary.Kind = strings.SplitN(key, ":", 2)[0]
	if summary.Records == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var rows []usageEventModel
	if err := query().Where("id > ? AND id <= ?", cursor, snapshot).Order("id ASC").Limit(timelineDetailSize + 1).Find(&rows).Error; err != nil {
		return nil, err
	}
	next := uint64(0)
	if len(rows) > timelineDetailSize {
		rows = rows[:timelineDetailSize]
		next = uint64(rows[len(rows)-1].ID)
	}
	return &storage.TimelineDetail{Summary: summary, Items: usageEventRecords(rows, prices), Snapshot: snapshot, NextCursor: next}, nil
}
