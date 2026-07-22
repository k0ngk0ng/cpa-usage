// Package app composes the runtime: storage, services, drain, HTTP router,
// and the daily maintenance loop. App.Run blocks until ctx is cancelled.
package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/sirupsen/logrus"
	"golang.org/x/sync/errgroup"

	"github.com/k0ngk0ng/cpa-usage/internal/api"
	"github.com/k0ngk0ng/cpa-usage/internal/auth"
	"github.com/k0ngk0ng/cpa-usage/internal/config"
	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/drain"
	"github.com/k0ngk0ng/cpa-usage/internal/logging"
	"github.com/k0ngk0ng/cpa-usage/internal/metadata"
	"github.com/k0ngk0ng/cpa-usage/internal/pricing"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"github.com/k0ngk0ng/cpa-usage/internal/storage/sqlite"
	"github.com/k0ngk0ng/cpa-usage/internal/usage"
)

// BuildInfo carries values injected via -ldflags from cmd/server.
type BuildInfo struct {
	Version   string
	Commit    string
	BuildDate string
}

// App is the assembled runtime.
type App struct {
	cfg      *config.Config
	build    BuildInfo
	logger   *logrus.Logger
	store    storage.Store
	pricing  *pricing.Service
	usage    *usage.Service
	metadata *metadata.Service
	drain    *drain.Drain
	server   *http.Server
}

// New constructs an App from a loaded Config.
func New(cfg *config.Config, build BuildInfo) (*App, error) {
	cfg.ApplyTimezone()
	logger, err := logging.Setup(logging.Config{
		Level:         cfg.LogLevel,
		FileEnabled:   cfg.LogFile,
		Dir:           cfg.LogDir,
		RetentionDays: cfg.LogRetention,
	})
	if err != nil {
		return nil, fmt.Errorf("setup logging: %w", err)
	}

	store, err := openStore(cfg)
	if err != nil {
		return nil, err
	}

	priceSvc := pricing.New(store)
	if err := priceSvc.Reload(context.Background()); err != nil {
		logger.WithError(err).Warn("initial pricing reload failed")
	}

	displays := usage.NewDisplayResolver(store)
	usageSvc := usage.New(store, priceSvc, displays)

	cpaClient := cpa.NewClient(cfg.CPABaseURL, cfg.CPAManagementKey, cfg.RequestTimeout)
	metaSvc := metadata.New(cpaClient, store, logger)

	queue := cpa.NewRedisQueue(cpa.RedisQueueConfig{
		BaseURL:       cfg.CPABaseURL,
		OverrideAddr:  cfg.RedisQueueAddr,
		ManagementKey: cfg.CPAManagementKey,
		QueueKey:      cfg.RedisQueueKey,
		Timeout:       cfg.RequestTimeout,
		BatchSize:     cfg.RedisQueueBatch,
	})
	drainSvc := drain.New(queue, store, metaSvc, logger, drain.Config{
		IdleInterval:     cfg.RedisIdleInterval,
		ErrorBackoff:     cfg.RedisErrorBackoff,
		MetadataInterval: cfg.MetadataInterval,
	})

	tokens := auth.NewTokenManager(cfg.AuthTokenTTL, cfg.LoginPassword)

	router := api.New(api.RouterConfig{
		BasePath: cfg.AppBasePath,
		Build: api.BuildInfo{
			Version:   build.Version,
			Commit:    build.Commit,
			BuildDate: build.BuildDate,
		},
		Logger: logger,
		Auth: api.AuthDeps{
			Enabled:    cfg.AuthEnabled,
			Password:   cfg.LoginPassword,
			CookieName: cfg.CookieName,
			BasePath:   cfg.AppBasePath,
			Tokens:     tokens,
		},
		Usage: api.UsageDeps{
			Service:       usageSvc,
			Store:         store,
			LogDownloader: cpaClient,
			LogReader: &cpa.LogReader{
				Dir:            cfg.CPALogDir,
				MaxBodyBytes:   cfg.LogBodyMaxBytes,
				MaxHeaderBytes: cfg.LogHeaderMaxBytes,
			},
		},
		Pricing: api.PricingDeps{Service: priceSvc},
		Aliases: api.AliasDeps{Store: store},
		Meta: api.MetaDeps{
			Store:   store,
			Drain:   drainSvc,
			CPA:     cpaClient,
			SyncNow: drainSvc.SyncNow,
		},
	})

	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.AppPort),
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	return &App{
		cfg:      cfg,
		build:    build,
		logger:   logger,
		store:    store,
		pricing:  priceSvc,
		usage:    usageSvc,
		metadata: metaSvc,
		drain:    drainSvc,
		server:   server,
	}, nil
}

// Run starts the drain loop, maintenance loop, and HTTP server in parallel,
// blocking until ctx is cancelled.
func (a *App) Run(ctx context.Context) error {
	a.logger.WithFields(logrus.Fields{
		"version":              a.build.Version,
		"base_path":            a.cfg.AppBasePath,
		"port":                 a.cfg.AppPort,
		"sqlite":               a.cfg.SQLitePath,
		"usage_retention_days": a.cfg.UsageRetentionDays,
		"redis_addr":           a.cfg.RedisQueueAddr,
		"redis_key":            a.cfg.RedisQueueKey,
		"tz":                   a.cfg.TZ,
	}).Info("cpa-usage starting")

	g, gctx := errgroup.WithContext(ctx)

	g.Go(func() error { return a.drain.Run(gctx) })
	if a.cfg.UsageRetentionDays > 0 {
		g.Go(func() error { return runMaintenance(gctx, a.store, a.logger) })
	} else {
		a.logger.Info("usage retention cleanup disabled; usage data will be kept indefinitely")
	}

	g.Go(func() error {
		a.logger.WithField("addr", a.server.Addr).Info("http server listening")
		err := a.server.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	})

	g.Go(func() error {
		<-gctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return a.server.Shutdown(shutdownCtx)
	})

	return g.Wait()
}

// Close releases resources. Safe to call multiple times.
func (a *App) Close() error {
	if a.store != nil {
		return a.store.Close()
	}
	return nil
}

// openStore builds the configured storage backend. v1 only supports sqlite;
// the switch leaves room to plug in mysql/postgres/clickhouse later without
// touching app wiring.
func openStore(cfg *config.Config) (storage.Store, error) {
	switch cfg.StorageDriver {
	case "sqlite":
		return sqlite.Open(sqlite.Config{
			Path:          cfg.SQLitePath,
			RetentionDays: cfg.UsageRetentionDays,
		})
	default:
		return nil, fmt.Errorf("unsupported STORAGE_DRIVER %q", cfg.StorageDriver)
	}
}
