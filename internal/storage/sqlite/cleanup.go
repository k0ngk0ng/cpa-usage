package sqlite

import (
	"context"
	"time"
)

// retentionDays controls how many days of usage rows are kept.
// Anything older than `now - retentionDays` is purged during Cleanup.
const retentionDays = 30

// Cleanup deletes usage events older than the retention window and runs VACUUM.
// It is invoked daily from the maintenance loop.
func (s *Store) Cleanup(ctx context.Context, now time.Time) error {
	cutoff := now.Add(-time.Duration(retentionDays) * 24 * time.Hour).UTC()
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
