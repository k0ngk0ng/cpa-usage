package sqlite

import (
	"context"
	"time"
)

// Cleanup deletes usage events older than the retention window and runs VACUUM.
// A non-positive retention value disables cleanup and retains all usage rows.
func (s *Store) Cleanup(ctx context.Context, now time.Time) error {
	if s.retentionDays <= 0 {
		return nil
	}
	cutoff := now.Add(-time.Duration(s.retentionDays) * 24 * time.Hour).UTC()
	if err := s.dbCtx(ctx).
		Where("timestamp < ?", cutoff).
		Delete(&usageEventModel{}).Error; err != nil {
		return err
	}
	if err := s.dbCtx(ctx).Exec("VACUUM").Error; err != nil {
		return err
	}
	return nil
}
