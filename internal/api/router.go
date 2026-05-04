// Package api wires HTTP handlers, middleware, and the embedded SPA.
// All routes are mounted under cfg.BasePath (default "/usage"); set BasePath
// to "" to serve at root.
package api

import (
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// BuildInfo carries the cpa-usage build identifiers (injected via -ldflags).
type BuildInfo struct {
	Version   string
	Commit    string
	BuildDate string
}

// RouterConfig describes everything the router needs at startup.
type RouterConfig struct {
	BasePath string
	Build    BuildInfo
	Logger   *logrus.Logger

	Auth    AuthDeps
	Usage   UsageDeps
	Pricing PricingDeps
	Meta    MetaDeps
}

// New builds the gin engine with all routes registered.
func New(cfg RouterConfig) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(loggingMiddleware(cfg.Logger))

	// Health is unprefixed so external probes can hit a stable path even if
	// the operator changes APP_BASE_PATH.
	r.GET("/healthz", healthHandler())

	base := r.Group(cfg.BasePath)
	{
		base.GET("/healthz", healthHandler())

		api := base.Group("/api/v1")
		{
			// Public auth endpoints
			api.GET("/ping", pingHandler(cfg.Build.Version))
			api.GET("/version", versionHandler(cfg.Build, cfg.Meta))
			api.GET("/auth/session", sessionHandler(cfg.Auth))
			api.POST("/auth/login", loginHandler(cfg.Auth))
			api.POST("/auth/logout", logoutHandler(cfg.Auth))

			// Authenticated endpoints
			protected := api.Group("")
			protected.Use(authMiddleware(cfg.Auth))
			{
				protected.GET("/status", statusHandler(cfg.Meta))
				protected.POST("/sync", syncHandler(cfg.Meta))

				protected.GET("/usage/overview", usageOverviewHandler(cfg.Usage))
				protected.GET("/usage/analysis", usageAnalysisHandler(cfg.Usage))
				protected.GET("/usage/events", usageEventsHandler(cfg.Usage))
				protected.GET("/usage/events/filters", usageEventFiltersHandler(cfg.Usage))
				protected.GET("/usage/events/:request_id/log", usageEventLogHandler(cfg.Usage))
				protected.GET("/usage/events/:request_id/log/raw", usageEventLogRawHandler(cfg.Usage))
				protected.GET("/usage/credentials", usageCredentialsHandler(cfg.Usage))
				protected.POST("/usage/import", usageImportHandler(cfg.Usage))
				protected.POST("/usage/backfill-request-ids", usageBackfillHandler(cfg.Usage))

				protected.GET("/auth-files", authFilesHandler(cfg.Meta))
				protected.GET("/provider-metadata", providerMetadataHandler(cfg.Meta))
				protected.GET("/models/used", usedModelsHandler(cfg.Meta))

				protected.GET("/pricing", listPricingHandler(cfg.Pricing))
				protected.PUT("/pricing", upsertPricingHandler(cfg.Pricing))
				protected.PUT("/pricing/:model", upsertPricingHandler(cfg.Pricing))
				protected.DELETE("/pricing", deletePricingHandler(cfg.Pricing))
				protected.DELETE("/pricing/:model", deletePricingHandler(cfg.Pricing))
			}
		}

		// SPA mount
		base.GET("", serveSPA(cfg.BasePath))
		base.GET("/", serveSPA(cfg.BasePath))
	}

	r.NoRoute(serveSPA(cfg.BasePath))
	return r
}

func loggingMiddleware(logger *logrus.Logger) gin.HandlerFunc {
	if logger == nil {
		logger = logrus.New()
	}
	return func(c *gin.Context) {
		c.Next()
		if c.Writer.Status() >= 500 {
			logger.WithFields(logrus.Fields{
				"method": c.Request.Method,
				"path":   c.Request.URL.Path,
				"status": c.Writer.Status(),
			}).Warn("request failed")
		}
	}
}
