package sqlite

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	glebarezsqlite "github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

type legacyUsageEventModel struct {
	ID          uint   `gorm:"primaryKey"`
	EventKey    string `gorm:"uniqueIndex"`
	RequestID   string
	ServiceTier string
}

func (legacyUsageEventModel) TableName() string { return "usage_events" }

type legacyPriceModel struct {
	ID                   uint    `gorm:"primaryKey"`
	Model                string  `gorm:"uniqueIndex"`
	PromptPricePer1M     float64 `gorm:"column:prompt_price_per_1m"`
	CompletionPricePer1M float64 `gorm:"column:completion_price_per_1m"`
	CachePricePer1M      float64 `gorm:"column:cache_price_per_1m"`
	UpdatedAt            time.Time
}

func (legacyPriceModel) TableName() string { return "model_price_settings" }

func TestOpenMigratesPreV721Schema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := gorm.Open(glebarezsqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	if err := legacy.AutoMigrate(&legacyUsageEventModel{}, &legacyPriceModel{}); err != nil {
		t.Fatalf("migrate legacy schema: %v", err)
	}
	if err := legacy.Create(&legacyUsageEventModel{EventKey: "req-1", RequestID: "req-1", ServiceTier: "priority"}).Error; err != nil {
		t.Fatalf("insert legacy usage: %v", err)
	}
	if err := legacy.Create(&legacyPriceModel{Model: "m", PromptPricePer1M: 2, CachePricePer1M: 1}).Error; err != nil {
		t.Fatalf("insert legacy price: %v", err)
	}
	legacySQL, err := legacy.DB()
	if err != nil {
		t.Fatalf("legacy sql db: %v", err)
	}
	if err := legacySQL.Close(); err != nil {
		t.Fatalf("close legacy db: %v", err)
	}

	store, err := Open(Config{Path: path})
	if err != nil {
		t.Fatalf("Open upgraded db: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	for _, column := range []string{"executor_type", "request_service_tier", "response_service_tier"} {
		if !store.db.Migrator().HasColumn(&usageEventModel{}, column) {
			t.Fatalf("usage_events missing migrated column %q", column)
		}
	}
	if !store.db.Migrator().HasColumn(&modelPriceSettingModel{}, "cache_write_price_per_1m") {
		t.Fatal("model_price_settings missing cache_write_price_per_1m")
	}

	var usage usageEventModel
	if err := store.db.First(&usage, "event_key = ?", "req-1").Error; err != nil {
		t.Fatalf("read migrated usage: %v", err)
	}
	if usage.ServiceTier != "priority" {
		t.Fatalf("service tier = %q, want priority", usage.ServiceTier)
	}
	page, err := store.ListUsageEvents(context.Background(), storage.UsageFilter{}, storage.Page{Page: 1, PageSize: 20}, nil)
	if err != nil {
		t.Fatalf("list migrated usage: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].RequestServiceTier != "priority" {
		t.Fatalf("migrated request tier = %#v", page.Items)
	}
	var price modelPriceSettingModel
	if err := store.db.First(&price, "model = ?", "m").Error; err != nil {
		t.Fatalf("read migrated price: %v", err)
	}
	if price.CacheWritePricePer1M != nil {
		t.Fatalf("legacy cache write price = %v, want nil fallback", *price.CacheWritePricePer1M)
	}
}
