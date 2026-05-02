// Package config loads runtime configuration from the process environment.
// All fields are optional unless explicitly required. Defaults match the
// behavior expected by cpa-usage-install.sh.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the fully-populated runtime configuration.
type Config struct {
	CPABaseURL       string
	CPAManagementKey string
	RequestTimeout   time.Duration

	AppPort     int
	AppBasePath string

	StorageDriver string
	SQLitePath    string

	RedisQueueAddr     string
	RedisQueueBatch    int
	RedisIdleInterval  time.Duration
	RedisErrorBackoff  time.Duration
	MetadataInterval   time.Duration

	TZ           string
	LogLevel     string
	LogFile      bool
	LogDir       string
	LogRetention int

	AuthEnabled    bool
	LoginPassword  string
	SessionTTL     time.Duration
	CookieName     string
}

// Load reads the configuration from environment variables.
func Load() (*Config, error) {
	cfg := &Config{
		CPABaseURL:        strings.TrimSpace(os.Getenv("CPA_BASE_URL")),
		CPAManagementKey:  strings.TrimSpace(os.Getenv("CPA_MANAGEMENT_KEY")),
		RequestTimeout:    durationOr("REQUEST_TIMEOUT", 30*time.Second),
		AppPort:           intOr("APP_PORT", 8080),
		AppBasePath:       basePathOr(os.Getenv("APP_BASE_PATH"), "/usage"),
		StorageDriver:     strOr("STORAGE_DRIVER", "sqlite"),
		SQLitePath:        strOr("SQLITE_PATH", "/var/lib/cpa-usage/app.db"),
		RedisQueueAddr:    strings.TrimSpace(os.Getenv("REDIS_QUEUE_ADDR")),
		RedisQueueBatch:   intOr("REDIS_QUEUE_BATCH_SIZE", 1000),
		RedisIdleInterval: durationOr("REDIS_QUEUE_IDLE_INTERVAL", time.Second),
		RedisErrorBackoff: durationOr("REDIS_QUEUE_ERROR_BACKOFF", 10*time.Second),
		MetadataInterval:  durationOr("METADATA_SYNC_INTERVAL", 30*time.Second),
		TZ:                strOr("TZ", "Asia/Shanghai"),
		LogLevel:          strOr("LOG_LEVEL", "info"),
		LogFile:           boolOr("LOG_FILE_ENABLED", true),
		LogDir:            strOr("LOG_DIR", "/var/lib/cpa-usage/logs"),
		LogRetention:      intOr("LOG_RETENTION_DAYS", 7),
		AuthEnabled:       boolOr("AUTH_ENABLED", false),
		LoginPassword:     os.Getenv("LOGIN_PASSWORD"),
		SessionTTL:        durationOr("AUTH_SESSION_TTL", 168*time.Hour),
		CookieName:        strOr("AUTH_COOKIE_NAME", "cpa_usage_session"),
	}
	if cfg.CPABaseURL == "" {
		return nil, errors.New("CPA_BASE_URL is required")
	}
	if cfg.CPAManagementKey == "" {
		return nil, errors.New("CPA_MANAGEMENT_KEY is required")
	}
	if cfg.AuthEnabled && strings.TrimSpace(cfg.LoginPassword) == "" {
		return nil, errors.New("LOGIN_PASSWORD is required when AUTH_ENABLED=true")
	}
	if cfg.StorageDriver != "sqlite" {
		return nil, fmt.Errorf("unsupported STORAGE_DRIVER %q (only sqlite supported in v1)", cfg.StorageDriver)
	}
	return cfg, nil
}

// ApplyTimezone overrides time.Local from cfg.TZ; fall through silently if
// the IANA name cannot be resolved (Linux deployments may not ship tzdata).
func (c *Config) ApplyTimezone() {
	if c.TZ == "" {
		return
	}
	if loc, err := time.LoadLocation(c.TZ); err == nil {
		time.Local = loc
	}
}

func strOr(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return v
}

func intOr(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func boolOr(key string, def bool) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func durationOr(key string, def time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}

// basePathOr normalizes a base path: leading slash, no trailing slash.
// Empty input keeps the supplied default.
func basePathOr(in, def string) string {
	in = strings.TrimSpace(in)
	if in == "" {
		in = def
	}
	if in == "" || in == "/" {
		return ""
	}
	if !strings.HasPrefix(in, "/") {
		in = "/" + in
	}
	return strings.TrimRight(in, "/")
}
