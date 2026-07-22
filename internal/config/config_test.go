package config

import "testing"

func TestUsageRetentionDefaultsToDisabled(t *testing.T) {
	t.Setenv("CPA_BASE_URL", "http://127.0.0.1:8317")
	t.Setenv("CPA_MANAGEMENT_KEY", "test-key")
	t.Setenv("AUTH_ENABLED", "false")
	t.Setenv("STORAGE_DRIVER", "sqlite")
	t.Setenv("USAGE_RETENTION_DAYS", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UsageRetentionDays != 0 {
		t.Fatalf("UsageRetentionDays = %d, want 0", cfg.UsageRetentionDays)
	}
}

func TestUsageRetentionCanBeConfigured(t *testing.T) {
	t.Setenv("CPA_BASE_URL", "http://127.0.0.1:8317")
	t.Setenv("CPA_MANAGEMENT_KEY", "test-key")
	t.Setenv("AUTH_ENABLED", "false")
	t.Setenv("STORAGE_DRIVER", "sqlite")
	t.Setenv("USAGE_RETENTION_DAYS", "90")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UsageRetentionDays != 90 {
		t.Fatalf("UsageRetentionDays = %d, want 90", cfg.UsageRetentionDays)
	}
}
