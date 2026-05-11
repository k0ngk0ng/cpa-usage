package sqlite

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

const insertChunkSize = 200

// InsertUsageEvents bulk-inserts events with ON CONFLICT (event_key) DO NOTHING.
// It returns the number of new rows and the number of duplicates that were skipped.
func (s *Store) InsertUsageEvents(ctx context.Context, events []storage.UsageEvent) (int, int, error) {
	if len(events) == 0 {
		return 0, 0, nil
	}
	now := time.Now().UTC()
	rows := make([]usageEventModel, 0, len(events))
	for _, e := range events {
		if e.EventKey == "" {
			continue
		}
		insertedAt := e.InsertedAt
		if insertedAt.IsZero() {
			insertedAt = now
		}
		rows = append(rows, usageEventModel{
			EventKey:        e.EventKey,
			Timestamp:       e.Timestamp.UTC(),
			Provider:        e.Provider,
			Model:           e.Model,
			APIGroupKey:     e.APIGroupKey,
			Source:          e.Source,
			AuthIndex:       e.AuthIndex,
			AuthType:        e.AuthType,
			APIKey:          e.APIKey,
			Endpoint:        e.Endpoint,
			RequestID:       e.RequestID,
			LatencyMs:       e.LatencyMs,
			InputTokens:     e.InputTokens,
			OutputTokens:    e.OutputTokens,
			ReasoningTokens: e.ReasoningTokens,
			CachedTokens:    e.CachedTokens,
			TotalTokens:     e.TotalTokens,
			Failed:          e.Failed,
			InsertedAt:      insertedAt,
		})
	}
	if len(rows) == 0 {
		return 0, len(events), nil
	}

	totalInserted := 0
	for start := 0; start < len(rows); start += insertChunkSize {
		end := start + insertChunkSize
		if end > len(rows) {
			end = len(rows)
		}
		chunk := rows[start:end]
		res := s.dbCtx(ctx).
			Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "event_key"}}, DoNothing: true}).
			Create(&chunk)
		if res.Error != nil {
			return totalInserted, 0, res.Error
		}
		totalInserted += int(res.RowsAffected)
	}
	deduped := len(events) - totalInserted
	if deduped < 0 {
		deduped = 0
	}
	return totalInserted, deduped, nil
}

// LatestUsageEventTimestamp returns the maximum stored timestamp, zero if empty.
func (s *Store) LatestUsageEventTimestamp(ctx context.Context) (time.Time, error) {
	var ts time.Time
	row := struct{ Timestamp time.Time }{}
	res := s.dbCtx(ctx).
		Model(&usageEventModel{}).
		Select("MAX(timestamp) AS timestamp").
		Scan(&row)
	if res.Error != nil {
		if errors.Is(res.Error, gorm.ErrRecordNotFound) {
			return ts, nil
		}
		return ts, res.Error
	}
	return row.Timestamp, nil
}

// ListImportedEventsMissingRequestID returns the lightweight stubs used by
// the request-id backfill flow: every imported event (event_key prefixed
// with "import:") that still lacks a request_id, ordered by timestamp so
// callers can stream them against a sorted log-filename index.
func (s *Store) ListImportedEventsMissingRequestID(ctx context.Context) ([]storage.ImportedEventStub, error) {
	type row struct {
		EventKey  string
		Timestamp time.Time
		Model     string
	}
	var rows []row
	if err := s.dbCtx(ctx).
		Model(&usageEventModel{}).
		Select("event_key, timestamp, model").
		Where("event_key LIKE ?", "import:%").
		Where("request_id = ?", "").
		Order("timestamp ASC").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]storage.ImportedEventStub, 0, len(rows))
	for _, r := range rows {
		out = append(out, storage.ImportedEventStub{
			EventKey:  r.EventKey,
			Timestamp: r.Timestamp,
			Model:     r.Model,
		})
	}
	return out, nil
}

// UpdateImportedEventLink writes the matched request_id (and optional
// endpoint hint) onto a previously imported event identified by event_key.
// Endpoint is only overwritten when the column is currently empty so a
// later real ingest cannot be clobbered by a coarse filename-derived hint.
func (s *Store) UpdateImportedEventLink(ctx context.Context, eventKey, requestID, endpoint string) error {
	updates := map[string]interface{}{"request_id": requestID}
	q := s.dbCtx(ctx).
		Model(&usageEventModel{}).
		Where("event_key = ?", eventKey).
		Updates(updates)
	if q.Error != nil {
		return q.Error
	}
	if endpoint != "" {
		if err := s.dbCtx(ctx).
			Model(&usageEventModel{}).
			Where("event_key = ? AND endpoint = ?", eventKey, "").
			Update("endpoint", endpoint).Error; err != nil {
			return err
		}
	}
	return nil
}

// applyFilter returns a query scoped by the supplied UsageFilter.
func (s *Store) applyFilter(ctx context.Context, f storage.UsageFilter) *gorm.DB {
	q := s.dbCtx(ctx).Model(&usageEventModel{})
	if !f.Start.IsZero() {
		q = q.Where("timestamp >= ?", f.Start.UTC())
	}
	if !f.End.IsZero() {
		q = q.Where("timestamp < ?", f.End.UTC())
	}
	if len(f.Models) > 0 {
		q = q.Where("model IN ?", f.Models)
	}
	if len(f.Sources) > 0 {
		q = q.Where("source IN ?", f.Sources)
	}
	if f.AuthIndex != "" {
		q = q.Where("auth_index = ?", f.AuthIndex)
	}
	if len(f.APIKeys) > 0 {
		q = q.Where("api_key IN ?", f.APIKeys)
	}
	switch f.Result {
	case "success":
		q = q.Where("failed = ?", false)
	case "failed":
		q = q.Where("failed = ?", true)
	}
	return q
}

// computeCost evaluates per-event cost given the model price catalog.
func computeCost(model string, input, completion, cached int64, prices map[string]storage.ModelPriceSetting) float64 {
	if prices == nil {
		return 0
	}
	p, ok := prices[strings.TrimSpace(model)]
	if !ok {
		return 0
	}
	const oneM = 1_000_000.0
	cost := float64(input)/oneM*p.PromptPricePer1M +
		float64(completion)/oneM*p.CompletionPricePer1M +
		float64(cached)/oneM*p.CachePricePer1M
	return cost
}

// ListUsageEvents returns paginated raw events.
func (s *Store) ListUsageEvents(ctx context.Context, f storage.UsageFilter, p storage.Page, prices map[string]storage.ModelPriceSetting) (*storage.UsageEventsPage, error) {
	if p.Page <= 0 {
		p.Page = 1
	}
	if !pageSizeAllowed(p.PageSize) {
		p.PageSize = storage.DefaultPageSize
	}

	var total int64
	if err := s.applyFilter(ctx, f).Count(&total).Error; err != nil {
		return nil, err
	}

	var rows []usageEventModel
	if err := s.applyFilter(ctx, f).
		Order("timestamp DESC, id DESC").
		Offset((p.Page - 1) * p.PageSize).
		Limit(p.PageSize).
		Find(&rows).Error; err != nil {
		return nil, err
	}

	items := make([]storage.UsageEventRecord, 0, len(rows))
	for _, r := range rows {
		items = append(items, storage.UsageEventRecord{
			EventKey:        r.EventKey,
			Timestamp:       r.Timestamp,
			Provider:        r.Provider,
			Model:           r.Model,
			APIGroupKey:     r.APIGroupKey,
			Source:          r.Source,
			AuthIndex:       r.AuthIndex,
			AuthType:        r.AuthType,
			Endpoint:        r.Endpoint,
			RequestID:       r.RequestID,
			LatencyMs:       r.LatencyMs,
			InputTokens:     r.InputTokens,
			OutputTokens:    r.OutputTokens,
			ReasoningTokens: r.ReasoningTokens,
			CachedTokens:    r.CachedTokens,
			TotalTokens:     r.TotalTokens,
			Failed:          r.Failed,
			Cost:            computeCost(r.Model, r.InputTokens, r.OutputTokens, r.CachedTokens, prices),
		})
	}
	totalPages := int((total + int64(p.PageSize) - 1) / int64(p.PageSize))
	if totalPages == 0 && total > 0 {
		totalPages = 1
	}
	return &storage.UsageEventsPage{
		Total:      total,
		Page:       p.Page,
		PageSize:   p.PageSize,
		TotalPages: totalPages,
		Items:      items,
	}, nil
}

// ListUsageEventFilterOptions returns distinct models/sources within the filter window.
func (s *Store) ListUsageEventFilterOptions(ctx context.Context, f storage.UsageFilter) (*storage.UsageEventFilterOptions, error) {
	models := make([]string, 0)
	sources := make([]string, 0)
	q1 := s.applyFilter(ctx, f).Distinct("model").Order("model")
	if err := q1.Pluck("model", &models).Error; err != nil {
		return nil, err
	}
	q2 := s.applyFilter(ctx, f).Distinct("source").Order("source")
	if err := q2.Pluck("source", &sources).Error; err != nil {
		return nil, err
	}
	return &storage.UsageEventFilterOptions{
		Models:  trimNonEmpty(models),
		Sources: trimNonEmpty(sources),
	}, nil
}

// ListUsageEventAPIKeys returns distinct raw api_key values within the filter window.
func (s *Store) ListUsageEventAPIKeys(ctx context.Context, f storage.UsageFilter) ([]string, error) {
	apiKeys := make([]string, 0)
	q := s.applyFilter(ctx, f).Distinct("api_key").Order("api_key")
	if err := q.Pluck("api_key", &apiKeys).Error; err != nil {
		return nil, err
	}
	return trimNonEmpty(apiKeys), nil
}

// ListUsageCredentialStats groups by source + auth_index, separating success/failure.
func (s *Store) ListUsageCredentialStats(ctx context.Context, f storage.UsageFilter) ([]storage.UsageCredentialStat, error) {
	type row struct {
		Source    string
		AuthIndex string
		Failed    bool
		Cnt       int64
	}
	var rows []row
	q := s.applyFilter(ctx, f).
		Select("source, auth_index, failed, COUNT(*) AS cnt").
		Group("source, auth_index, failed")
	if err := q.Scan(&rows).Error; err != nil {
		return nil, err
	}
	type key struct{ source, auth string }
	agg := make(map[key]*storage.UsageCredentialStat)
	for _, r := range rows {
		k := key{strings.TrimSpace(r.Source), strings.TrimSpace(r.AuthIndex)}
		stat, ok := agg[k]
		if !ok {
			stat = &storage.UsageCredentialStat{Source: k.source, AuthIndex: k.auth}
			agg[k] = stat
		}
		stat.Total += r.Cnt
		if r.Failed {
			stat.Failed += r.Cnt
		} else {
			stat.Success += r.Cnt
		}
	}
	out := make([]storage.UsageCredentialStat, 0, len(agg))
	for _, v := range agg {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Total != out[j].Total {
			return out[i].Total > out[j].Total
		}
		return out[i].Source < out[j].Source
	})
	return out, nil
}

// ListUsageAnalysis returns three aggregate slices: by API group, by model, and combined.
func (s *Store) ListUsageAnalysis(ctx context.Context, f storage.UsageFilter, prices map[string]storage.ModelPriceSetting) (*storage.UsageAnalysis, error) {
	type aggRow struct {
		APIGroupKey     string
		Model           string
		Total           int64
		Success         int64
		Failed          int64
		InputTokens     int64
		OutputTokens    int64
		ReasoningTokens int64
		CachedTokens    int64
		TotalTokens     int64
	}
	selectExpr := `api_group_key, model,
		COUNT(*) AS total,
		SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END) AS success,
		SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END) AS failed,
		SUM(input_tokens) AS input_tokens,
		SUM(output_tokens) AS output_tokens,
		SUM(reasoning_tokens) AS reasoning_tokens,
		SUM(cached_tokens) AS cached_tokens,
		SUM(total_tokens) AS total_tokens`
	var rows []aggRow
	if err := s.applyFilter(ctx, f).
		Select(selectExpr).
		Group("api_group_key, model").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := &storage.UsageAnalysis{}
	apiAgg := make(map[string]*storage.UsageAggregationRow)
	modelAgg := make(map[string]*storage.UsageAggregationRow)
	for _, r := range rows {
		row := storage.UsageAggregationRow{
			APIGroupKey:     r.APIGroupKey,
			Model:           r.Model,
			Total:           r.Total,
			Success:         r.Success,
			Failed:          r.Failed,
			InputTokens:     r.InputTokens,
			OutputTokens:    r.OutputTokens,
			ReasoningTokens: r.ReasoningTokens,
			CachedTokens:    r.CachedTokens,
			TotalTokens:     r.TotalTokens,
			Cost:            costFromTotals(r.Model, r.InputTokens, r.OutputTokens, r.CachedTokens, prices),
		}
		out.ByAPIAndModel = append(out.ByAPIAndModel, row)

		if a, ok := apiAgg[r.APIGroupKey]; ok {
			mergeAgg(a, row)
		} else {
			cp := row
			cp.Model = ""
			apiAgg[r.APIGroupKey] = &cp
		}
		if m, ok := modelAgg[r.Model]; ok {
			mergeAgg(m, row)
		} else {
			cp := row
			cp.APIGroupKey = ""
			modelAgg[r.Model] = &cp
		}
	}
	for _, v := range apiAgg {
		out.ByAPI = append(out.ByAPI, *v)
	}
	for _, v := range modelAgg {
		out.ByModel = append(out.ByModel, *v)
	}
	sortAgg(out.ByAPI)
	sortAgg(out.ByModel)
	sortAgg(out.ByAPIAndModel)
	return out, nil
}

func mergeAgg(dst *storage.UsageAggregationRow, src storage.UsageAggregationRow) {
	dst.Total += src.Total
	dst.Success += src.Success
	dst.Failed += src.Failed
	dst.InputTokens += src.InputTokens
	dst.OutputTokens += src.OutputTokens
	dst.ReasoningTokens += src.ReasoningTokens
	dst.CachedTokens += src.CachedTokens
	dst.TotalTokens += src.TotalTokens
	dst.Cost += src.Cost
}

func sortAgg(rows []storage.UsageAggregationRow) {
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Total != rows[j].Total {
			return rows[i].Total > rows[j].Total
		}
		if rows[i].APIGroupKey != rows[j].APIGroupKey {
			return rows[i].APIGroupKey < rows[j].APIGroupKey
		}
		return rows[i].Model < rows[j].Model
	})
}

func costFromTotals(model string, input, output, cached int64, prices map[string]storage.ModelPriceSetting) float64 {
	return computeCost(model, input, output, cached, prices)
}

// BuildUsageOverview returns the summary, hourly+daily series and a range-sized 15-minute health grid.
func (s *Store) BuildUsageOverview(ctx context.Context, f storage.UsageFilter, prices map[string]storage.ModelPriceSetting) (*storage.UsageOverview, error) {
	now := time.Now().UTC()

	// Summary aggregation
	type sumRow struct {
		Total           int64
		Success         int64
		Failed          int64
		InputTokens     int64
		OutputTokens    int64
		ReasoningTokens int64
		CachedTokens    int64
		TotalTokens     int64
	}
	var sumRowResult sumRow
	if err := s.applyFilter(ctx, f).
		Select(`COUNT(*) AS total,
			SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END) AS success,
			SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END) AS failed,
			SUM(input_tokens) AS input_tokens,
			SUM(output_tokens) AS output_tokens,
			SUM(reasoning_tokens) AS reasoning_tokens,
			SUM(cached_tokens) AS cached_tokens,
			SUM(total_tokens) AS total_tokens`).
		Scan(&sumRowResult).Error; err != nil {
		return nil, err
	}

	// For cost across models we need to iterate per-model totals.
	type byModelRow struct {
		Model        string
		InputTokens  int64
		OutputTokens int64
		CachedTokens int64
	}
	var perModel []byModelRow
	if err := s.applyFilter(ctx, f).
		Select("model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cached_tokens) AS cached_tokens").
		Group("model").
		Scan(&perModel).Error; err != nil {
		return nil, err
	}
	cost := 0.0
	for _, m := range perModel {
		cost += computeCost(m.Model, m.InputTokens, m.OutputTokens, m.CachedTokens, prices)
	}

	// Hourly (last 24h) + daily (last 7d) series via SQL bucketing using strftime.
	hourly, err := s.bucketSeriesHourly(ctx, f, now, prices)
	if err != nil {
		return nil, err
	}
	daily, err := s.bucketSeriesDaily(ctx, f, now, prices)
	if err != nil {
		return nil, err
	}
	health, err := s.healthGrid(ctx, f, now)
	if err != nil {
		return nil, err
	}

	return &storage.UsageOverview{
		Summary: storage.UsageSummary{
			Total:           sumRowResult.Total,
			Success:         sumRowResult.Success,
			Failed:          sumRowResult.Failed,
			InputTokens:     sumRowResult.InputTokens,
			OutputTokens:    sumRowResult.OutputTokens,
			ReasoningTokens: sumRowResult.ReasoningTokens,
			CachedTokens:    sumRowResult.CachedTokens,
			TotalTokens:     sumRowResult.TotalTokens,
			Cost:            cost,
		},
		HourlySeries: hourly,
		DailySeries:  daily,
		HealthGrid:   health,
		GeneratedAt:  now,
	}, nil
}

// bucketRow is one (bucket, model) aggregate read from a strftime GROUP BY.
type bucketRow struct {
	Bucket          string
	Model           string
	Total           int64
	Success         int64
	Failed          int64
	InputTokens     int64
	OutputTokens    int64
	ReasoningTokens int64
	CachedTokens    int64
	TotalTokens     int64
}

func (s *Store) bucketSeriesHourly(ctx context.Context, f storage.UsageFilter, now time.Time, prices map[string]storage.ModelPriceSetting) ([]storage.UsageBucket, error) {
	hourlyFilter := f
	if hourlyFilter.Start.IsZero() || hourlyFilter.End.IsZero() {
		hourlyFilter.End = now
		hourlyFilter.Start = now.Add(-24 * time.Hour)
	}
	var rows []bucketRow
	if err := s.applyFilter(ctx, hourlyFilter).
		Select(`strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS bucket,
			model,
			COUNT(*) AS total,
			SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END) AS success,
			SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END) AS failed,
			SUM(input_tokens) AS input_tokens,
			SUM(output_tokens) AS output_tokens,
			SUM(reasoning_tokens) AS reasoning_tokens,
			SUM(cached_tokens) AS cached_tokens,
			SUM(total_tokens) AS total_tokens`).
		Group("bucket, model").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	return foldBuckets(rows, hourlyFilter.Start, hourlyFilter.End, time.Hour, prices), nil
}

func (s *Store) bucketSeriesDaily(ctx context.Context, f storage.UsageFilter, now time.Time, prices map[string]storage.ModelPriceSetting) ([]storage.UsageBucket, error) {
	dailyFilter := f
	if dailyFilter.Start.IsZero() || dailyFilter.End.IsZero() {
		end := startOfDay(now).Add(24 * time.Hour)
		dailyFilter.End = end
		dailyFilter.Start = end.Add(-7 * 24 * time.Hour)
	}
	var rows []bucketRow
	if err := s.applyFilter(ctx, dailyFilter).
		Select(`strftime('%Y-%m-%d', timestamp, 'localtime') AS bucket,
			model,
			COUNT(*) AS total,
			SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END) AS success,
			SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END) AS failed,
			SUM(input_tokens) AS input_tokens,
			SUM(output_tokens) AS output_tokens,
			SUM(reasoning_tokens) AS reasoning_tokens,
			SUM(cached_tokens) AS cached_tokens,
			SUM(total_tokens) AS total_tokens`).
		Group("bucket, model").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	return foldBucketsDaily(rows, dailyFilter.Start, dailyFilter.End, prices), nil
}

func (s *Store) healthGrid(ctx context.Context, f storage.UsageFilter, now time.Time) ([][]storage.HealthCell, error) {
	healthFilter := f
	end := startOfDay(now).Add(24 * time.Hour)
	if healthFilter.HasRange() {
		healthFilter.Start = startOfDay(healthFilter.Start)
		healthFilter.End = startOfDay(healthFilter.End.Add(-time.Nanosecond)).Add(24 * time.Hour)
		if healthFilter.End.Sub(healthFilter.Start) > 30*24*time.Hour {
			healthFilter.Start = healthFilter.End.Add(-30 * 24 * time.Hour)
		}
	} else {
		healthFilter.End = end
		healthFilter.Start = end.Add(-30 * 24 * time.Hour)
	}
	type row struct {
		Bucket string
		Total  int64
		Failed int64
	}
	var rows []row
	if err := s.applyFilter(ctx, healthFilter).
		Select(`strftime('%Y-%m-%d %H:%M', datetime((strftime('%s', timestamp) / 900) * 900, 'unixepoch')) AS bucket,
			COUNT(*) AS total,
			SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END) AS failed`).
		Group("bucket").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	bucketMap := make(map[time.Time]storage.HealthCell, len(rows))
	for _, r := range rows {
		t, err := time.Parse("2006-01-02 15:04", r.Bucket)
		if err != nil {
			continue
		}
		bucketMap[t.UTC()] = storage.HealthCell{Bucket: t.UTC(), Total: r.Total, Failed: r.Failed}
	}

	days := int(healthFilter.End.Sub(healthFilter.Start).Hours() / 24)
	if days < 1 {
		days = 1
	}
	grid := make([][]storage.HealthCell, days)
	for d := 0; d < days; d++ {
		row := make([]storage.HealthCell, 96)
		dayStart := healthFilter.Start.Add(time.Duration(d) * 24 * time.Hour)
		for c := 0; c < 96; c++ {
			b := dayStart.Add(time.Duration(c) * 15 * time.Minute).UTC()
			if cell, ok := bucketMap[b]; ok {
				row[c] = cell
			} else {
				row[c] = storage.HealthCell{Bucket: b}
			}
		}
		grid[d] = row
	}
	return grid, nil
}

func foldBuckets(rows []bucketRow, start, end time.Time, step time.Duration, prices map[string]storage.ModelPriceSetting) []storage.UsageBucket {
	merged := make(map[time.Time]*storage.UsageBucket)
	for _, r := range rows {
		t, err := time.Parse("2006-01-02T15:04:05Z", r.Bucket)
		if err != nil {
			continue
		}
		t = t.UTC()
		b, ok := merged[t]
		if !ok {
			b = &storage.UsageBucket{Bucket: t}
			merged[t] = b
		}
		b.Total += r.Total
		b.Success += r.Success
		b.Failed += r.Failed
		b.InputTokens += r.InputTokens
		b.OutputTokens += r.OutputTokens
		b.ReasoningTokens += r.ReasoningTokens
		b.CachedTokens += r.CachedTokens
		b.TotalTokens += r.TotalTokens
		b.Cost += computeCost(r.Model, r.InputTokens, r.OutputTokens, r.CachedTokens, prices)
	}
	out := make([]storage.UsageBucket, 0)
	for t := start.UTC().Truncate(step); t.Before(end); t = t.Add(step) {
		if b, ok := merged[t]; ok {
			out = append(out, *b)
		} else {
			out = append(out, storage.UsageBucket{Bucket: t})
		}
	}
	return out
}

func foldBucketsDaily(rows []bucketRow, start, end time.Time, prices map[string]storage.ModelPriceSetting) []storage.UsageBucket {
	merged := make(map[string]*storage.UsageBucket)
	for _, r := range rows {
		t, err := time.ParseInLocation("2006-01-02", r.Bucket, time.Local)
		if err != nil {
			continue
		}
		key := r.Bucket
		b, ok := merged[key]
		if !ok {
			b = &storage.UsageBucket{Bucket: t}
			merged[key] = b
		}
		b.Total += r.Total
		b.Success += r.Success
		b.Failed += r.Failed
		b.InputTokens += r.InputTokens
		b.OutputTokens += r.OutputTokens
		b.ReasoningTokens += r.ReasoningTokens
		b.CachedTokens += r.CachedTokens
		b.TotalTokens += r.TotalTokens
		b.Cost += computeCost(r.Model, r.InputTokens, r.OutputTokens, r.CachedTokens, prices)
	}
	out := make([]storage.UsageBucket, 0)
	startLocal := startOfDayLocal(start)
	for d := startLocal; d.Before(end); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		if b, ok := merged[key]; ok {
			out = append(out, *b)
		} else {
			out = append(out, storage.UsageBucket{Bucket: d})
		}
	}
	return out
}

func startOfDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

func startOfDayLocal(t time.Time) time.Time {
	local := t.In(time.Local)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.Local)
}

func pageSizeAllowed(size int) bool {
	for _, allowed := range storage.PageSizeAllowed {
		if size == allowed {
			return true
		}
	}
	return false
}

func trimNonEmpty(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}
