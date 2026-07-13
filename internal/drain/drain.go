// Package drain consumes usage records from CPA's Redis-style subscription and
// LPOP backlog, decodes them, and persists to storage. A single drain instance
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
	LastPopAt          time.Time
	LastInsertedAt     time.Time
	LastErrorAt        time.Time
	LastError          string
	lastErrorSource    string
	LastMetadataSyncAt time.Time
	LastMetadataError  string
	TotalInserted      int64
	TotalDeduped       int64
	TotalDecodeErrors  int64
	BatchesPopped      int64
	RedisAddress       string
	RedisMode          string
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
		status:   Status{RedisAddress: queue.Address(), RedisMode: "starting"},
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

// Run prefers CPA's broadcast usage subscription and drains the pre-existing
// LPOP backlog after the subscription is active. Older CPA builds that reject
// SUBSCRIBE fall back to the legacy polling loop.
func (d *Drain) Run(ctx context.Context) error {
	d.logger.Info("drain started")
	defer d.logger.Info("drain stopped")

	metaTicker := time.NewTicker(d.cfg.MetadataInterval)
	defer metaTicker.Stop()
	initialMetadataSynced := false

	for {
		messages, subscriptionErrors, err := d.queue.SubscribeUsage(ctx)
		if err != nil {
			if errors.Is(err, cpa.ErrRedisSubscribeUnsupported) {
				d.setRedisMode("poll")
				d.clearError("subscribe")
				d.logger.WithError(err).Info("redis usage subscription unavailable; using LPOP polling")
				if !initialMetadataSynced {
					d.runInitialMetadataSync(ctx)
					initialMetadataSynced = true
				}
				return d.runPolling(ctx, metaTicker)
			}
			d.recordError("subscribe", err)
			d.logger.WithError(err).Warn("redis usage subscribe failed")
			if sleepCtx(ctx, d.cfg.ErrorBackoff) {
				return nil
			}
			continue
		}

		d.setRedisMode("subscribe")
		d.clearError("subscribe")
		if !initialMetadataSynced {
			d.runInitialMetadataSync(ctx)
			initialMetadataSynced = true
		}
		for {
			if err := d.drainBacklog(ctx); err != nil {
				d.recordError("pop", err)
				d.logger.WithError(err).Warn("redis backlog pop failed; retrying while live messages are buffered")
				if sleepCtx(ctx, d.cfg.ErrorBackoff) {
					return nil
				}
				continue
			}
			break
		}
		if err := d.runSubscription(ctx, metaTicker, messages, subscriptionErrors); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			d.recordError("subscribe", err)
			d.logger.WithError(err).Warn("redis usage subscription ended")
			if sleepCtx(ctx, d.cfg.ErrorBackoff) {
				return nil
			}
			continue
		}
		return nil
	}
}

func (d *Drain) runInitialMetadataSync(ctx context.Context) {
	if d.metadata == nil {
		return
	}
	if err := d.runMetadataSync(ctx); err != nil {
		d.logger.WithError(err).Warn("initial metadata sync failed")
	}
}

func (d *Drain) runPolling(ctx context.Context, metaTicker *time.Ticker) error {
	for {
		if d.handleMaintenance(ctx, metaTicker) {
			return nil
		}

		messages, err := d.queue.PopUsage(ctx)
		if err != nil {
			d.recordError("pop", err)
			d.logger.WithError(err).Warn("redis pop failed")
			if sleepCtx(ctx, d.cfg.ErrorBackoff) {
				return nil
			}
			continue
		}

		now := time.Now().UTC()
		d.recordPopSuccess(now)

		if len(messages) == 0 {
			if sleepCtx(ctx, d.cfg.IdleInterval) {
				return nil
			}
			continue
		}

		if !d.persistMessages(ctx, messages) {
			return nil
		}
	}
}

func (d *Drain) runSubscription(ctx context.Context, metaTicker *time.Ticker, messages <-chan string, subscriptionErrors <-chan error) error {
	batchSize := d.queue.BatchSize()
	if batchSize <= 0 {
		batchSize = 1000
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case respCh := <-d.syncReq:
			respCh <- d.runMetadataSync(ctx)
		case <-metaTicker.C:
			if err := d.runMetadataSync(ctx); err != nil {
				d.logger.WithError(err).Warn("metadata sync failed")
			}
		case err, ok := <-subscriptionErrors:
			if ok && err != nil {
				return err
			}
			subscriptionErrors = nil
		case message, ok := <-messages:
			if !ok {
				if err := pendingSubscriptionError(subscriptionErrors); err != nil {
					return err
				}
				return errors.New("redis usage subscription closed")
			}
			batch := []string{message}
		collectBatch:
			for len(batch) < batchSize {
				select {
				case next, open := <-messages:
					if !open {
						messages = nil
						break collectBatch
					}
					batch = append(batch, next)
				default:
					break collectBatch
				}
			}
			d.recordPopSuccess(time.Now().UTC())
			if !d.persistMessages(ctx, batch) {
				return nil
			}
			if messages == nil {
				if err := pendingSubscriptionError(subscriptionErrors); err != nil {
					return err
				}
				return errors.New("redis usage subscription closed")
			}
		}
	}
}

func (d *Drain) drainBacklog(ctx context.Context) error {
	for {
		messages, err := d.queue.PopUsage(ctx)
		if err != nil {
			return err
		}
		d.recordPopSuccess(time.Now().UTC())
		if len(messages) == 0 {
			return nil
		}
		if !d.persistMessages(ctx, messages) {
			return ctx.Err()
		}
	}
}

func (d *Drain) persistMessages(ctx context.Context, messages []string) bool {
	events, dropped := ingest.DecodeBatch(messages)
	if dropped > 0 {
		d.mu.Lock()
		d.status.TotalDecodeErrors += int64(dropped)
		d.mu.Unlock()
		d.logger.WithField("dropped", dropped).Warn("dropped malformed usage records")
	}
	if len(events) == 0 {
		return true
	}
	for {
		inserted, deduped, err := d.store.InsertUsageEvents(ctx, events)
		if err == nil {
			d.recordInsertSuccess(time.Now().UTC(), inserted, deduped)
			return true
		}
		d.recordError("insert", err)
		d.logger.WithError(err).Error("insert usage events failed; retaining batch for retry")
		if sleepCtx(ctx, d.cfg.ErrorBackoff) {
			return false
		}
	}
}

func (d *Drain) handleMaintenance(ctx context.Context, metaTicker *time.Ticker) bool {
	select {
	case <-ctx.Done():
		return true
	case respCh := <-d.syncReq:
		respCh <- d.runMetadataSync(ctx)
		return false
	case <-metaTicker.C:
		if err := d.runMetadataSync(ctx); err != nil {
			d.logger.WithError(err).Warn("metadata sync failed")
		}
		return false
	default:
		return false
	}
}

func pendingSubscriptionError(errorsCh <-chan error) error {
	if errorsCh == nil {
		return nil
	}
	select {
	case err := <-errorsCh:
		return err
	default:
		return nil
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

func (d *Drain) recordError(source string, err error) {
	d.mu.Lock()
	d.status.LastErrorAt = time.Now().UTC()
	d.status.LastError = err.Error()
	d.status.lastErrorSource = source
	d.mu.Unlock()
}

func (d *Drain) clearError(source string) {
	d.mu.Lock()
	if d.status.lastErrorSource == source {
		d.status.LastError = ""
		d.status.lastErrorSource = ""
	}
	d.mu.Unlock()
}

func (d *Drain) setRedisMode(mode string) {
	d.mu.Lock()
	d.status.RedisMode = mode
	d.mu.Unlock()
}

func (d *Drain) recordPopSuccess(at time.Time) {
	d.mu.Lock()
	d.status.LastPopAt = at
	d.status.BatchesPopped++
	if d.status.lastErrorSource == "pop" {
		d.status.LastError = ""
		d.status.lastErrorSource = ""
	}
	d.mu.Unlock()
}

func (d *Drain) recordInsertSuccess(at time.Time, inserted, deduped int) {
	d.mu.Lock()
	d.status.LastInsertedAt = at
	d.status.TotalInserted += int64(inserted)
	d.status.TotalDeduped += int64(deduped)
	if d.status.lastErrorSource == "insert" {
		d.status.LastError = ""
		d.status.lastErrorSource = ""
	}
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
