package sqlite

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// Config holds the SQLite-specific configuration.
type Config struct {
	Path string
}

// Store is the GORM-backed SQLite implementation of storage.Store.
type Store struct {
	db *gorm.DB
}

// Open opens (or creates) the SQLite database at cfg.Path, applies migrations
// and returns the Store ready for use.
func Open(cfg Config) (*Store, error) {
	if cfg.Path == "" {
		return nil, errors.New("sqlite path is required")
	}
	if dir := filepath.Dir(cfg.Path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("ensure sqlite dir: %w", err)
		}
	}
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)", cfg.Path)
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger:                                   logger.Default.LogMode(logger.Silent),
		DisableForeignKeyConstraintWhenMigrating: true,
	})
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if err := db.AutoMigrate(allModels()...); err != nil {
		return nil, fmt.Errorf("auto migrate: %w", err)
	}
	return &Store{db: db}, nil
}

// Close releases the underlying *sql.DB.
func (s *Store) Close() error {
	sqlDB, err := s.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// dbWithCtx returns a session bound to ctx.
func (s *Store) dbCtx(ctx context.Context) *gorm.DB { return s.db.WithContext(ctx) }

var _ storage.Store = (*Store)(nil)
