// Package drain runs the background loop that pops usage records from CPA's
// redis queue, decodes them, and persists to storage. A single drain instance
// also drives periodic metadata refreshes (auth-files / provider catalogs).
//
// Lifecycle: New(...) returns a Drain ready to Run; Run blocks until ctx is
// cancelled. Status() and SyncNow() are safe to call concurrently.
package drain

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/ingest"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// MetadataSyncer is implemented by the metadata service.
type MetadataSyncer interface {
	Sync(ctx context.Context) error
}

// Config tunes the drain loop's idle/error/metadata cadence.
type Config struct {
	IdleInterval     time.Duration
	ErrorBackoff     time.Duration
	MetadataInterval time.Duration
}

// Status is a snapshot of recent drain activity, exposed via /status.
type Status struct {
	LastPopAt           time.Time
	LastInsertedAt      time.Time
	LastErrorAt         time.Time
	LastError           string
	LastMetadataSyncAt  time.Time
	LastMetadataError   string
	TotalInserted       int64
	TotalDeduped        int64
	TotalDecodeErrors   int64
	BatchesPopped       int64
	RedisAddress        string
}

// Drain orchestrates the queue-pop / decode / insert / metadata-sync pipeline.
type Drain struct {
	queue    *cpa.RedisQueue
	store    storage.Store
	metadata MetadataSyncer
	logger   *logrus.Logger
	cfg      Config

	mu     sync.Mutex
	status Status

	syncReq chan chan error
}

// New constructs a Drain. Defaults are applied for any zero-valued Config field.
func New(queue *cpa.RedisQueue, store storage.Store, metadata MetadataSyncer, logger *logrus.Logger, cfg Config) *Drain {
	if cfg.IdleInterval <= 0 {
		cfg.IdleInterval = time.Second
	}
	if cfg.ErrorBackoff <= 0 {
		cfg.ErrorBackoff = 10 * time.Second
	}
	if cfg.MetadataInterval <= 0 {
		cfg.MetadataInterval = 30 * time.Second
	}
	if logger == nil {
		logger = logrus.New()
	}
	return &Drain{
		queue:    queue,
		store:    store,
		metadata: metadata,
		logger:   logger,
		cfg:      cfg,
		syncReq:  make(chan chan error, 1),
		status:   Status{RedisAddress: queue.Address()},
	}
}

// Status returns a copy of the most recent observed state.
func (d *Drain) Status() Status {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.status
}

// SyncNow blocks until a metadata refresh has run (or the loop exits).
func (d *Drain) SyncNow(ctx context.Context) error {
	if d.metadata == nil {
		return errors.New("metadata syncer not configured")
	}
	respCh := make(chan error, 1)
	select {
	case d.syncReq <- respCh:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-respCh:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Run drives the pop/decode/insert loop until ctx is cancelled.
// One ingest tick at a time keeps inserts strictly ordered and removes the need
// for the staging-table pattern used by cpa-usage-keeper.
func (d *Drain) Run(ctx context.Context) error {
	d.logger.Info("drain started")
	defer d.logger.Info("drain stopped")

	if d.metadata != nil {
		if err := d.runMetadataSync(ctx); err != nil {
			d.logger.WithError(err).Warn("initial metadata sync failed")
		}
	}

	metaTicker := time.NewTicker(d.cfg.MetadataInterval)
	defer metaTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		select {
		case respCh := <-d.syncReq:
			err := d.runMetadataSync(ctx)
			respCh <- err
			continue
		default:
		}

		select {
		case <-metaTicker.C:
			if err := d.runMetadataSync(ctx); err != nil {
				d.logger.WithError(err).Warn("metadata sync failed")
			}
		default:
		}

		messages, err := d.queue.PopUsage(ctx)
		if err != nil {
			d.recordError(err)
			d.logger.WithError(err).Warn("redis pop failed")
			if sleepCtx(ctx, d.cfg.ErrorBackoff) {
				return nil
			}
			continue
		}

		now := time.Now().UTC()
		d.mu.Lock()
		d.status.LastPopAt = now
		d.status.BatchesPopped++
		d.mu.Unlock()

		if len(messages) == 0 {
			if sleepCtx(ctx, d.cfg.IdleInterval) {
				return nil
			}
			continue
		}

		events, dropped := ingest.DecodeBatch(messages)
		if dropped > 0 {
			d.mu.Lock()
			d.status.TotalDecodeErrors += int64(dropped)
			d.mu.Unlock()
			d.logger.WithField("dropped", dropped).Warn("dropped malformed usage records")
		}
		if len(events) == 0 {
			continue
		}
		inserted, deduped, err := d.store.InsertUsageEvents(ctx, events)
		if err != nil {
			d.recordError(err)
			d.logger.WithError(err).Error("insert usage events failed")
			if sleepCtx(ctx, d.cfg.ErrorBackoff) {
				return nil
			}
			continue
		}
		d.mu.Lock()
		d.status.LastInsertedAt = time.Now().UTC()
		d.status.TotalInserted += int64(inserted)
		d.status.TotalDeduped += int64(deduped)
		d.mu.Unlock()
	}
}

func (d *Drain) runMetadataSync(ctx context.Context) error {
	if d.metadata == nil {
		return nil
	}
	err := d.metadata.Sync(ctx)
	d.mu.Lock()
	d.status.LastMetadataSyncAt = time.Now().UTC()
	if err != nil {
		d.status.LastMetadataError = err.Error()
	} else {
		d.status.LastMetadataError = ""
	}
	d.mu.Unlock()
	return err
}

func (d *Drain) recordError(err error) {
	d.mu.Lock()
	d.status.LastErrorAt = time.Now().UTC()
	d.status.LastError = err.Error()
	d.mu.Unlock()
}

// sleepCtx blocks for d or until ctx is cancelled. Returns true if cancelled.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return false
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return true
	case <-t.C:
		return false
	}
}
