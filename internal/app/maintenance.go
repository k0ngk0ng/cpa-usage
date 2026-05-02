package app

import (
	"context"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// runMaintenance fires once per day at ~03:00 local to run storage Cleanup
// (drop old usage rows + VACUUM). It also runs once at startup to recover
// from any missed window from the previous run.
func runMaintenance(ctx context.Context, store storage.Store, logger *logrus.Logger) error {
	if err := store.Cleanup(ctx, time.Now()); err != nil {
		logger.WithError(err).Warn("startup cleanup failed")
	}

	for {
		next := nextMaintenanceTime(time.Now())
		wait := time.Until(next)
		if wait < 0 {
			wait = time.Hour
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
			if err := store.Cleanup(ctx, time.Now()); err != nil {
				logger.WithError(err).Warn("daily cleanup failed")
			} else {
				logger.Info("daily cleanup completed")
			}
		}
	}
}

// nextMaintenanceTime returns the next 03:00 local-time instant strictly after now.
func nextMaintenanceTime(now time.Time) time.Time {
	t := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 0, 0, now.Location())
	if !t.After(now) {
		t = t.Add(24 * time.Hour)
	}
	return t
}
