package sqlite

import "time"

// usageEventModel is the GORM/sqlite-side schema. Rows are deduplicated on event_key.
type usageEventModel struct {
	ID              uint      `gorm:"primaryKey"`
	EventKey        string    `gorm:"uniqueIndex;size:128"`
	Timestamp       time.Time `gorm:"index"`
	Provider        string    `gorm:"size:64;index"`
	Model           string    `gorm:"size:128;index"`
	APIGroupKey     string    `gorm:"size:128;index;column:api_group_key"`
	Source          string    `gorm:"size:256;index"`
	AuthIndex       string    `gorm:"size:64;index"`
	AuthType        string    `gorm:"size:32"`
	APIKey          string    `gorm:"size:128;column:api_key"`
	Endpoint        string    `gorm:"size:128"`
	RequestID       string    `gorm:"size:64;column:request_id"`
	LatencyMs       int64
	InputTokens     int64
	OutputTokens    int64
	ReasoningTokens int64
	CachedTokens    int64
	TotalTokens     int64
	Failed          bool `gorm:"index"`
	InsertedAt      time.Time
}

func (usageEventModel) TableName() string { return "usage_events" }

type authFileModel struct {
	ID          uint   `gorm:"primaryKey"`
	AuthIndex   string `gorm:"uniqueIndex;size:64"`
	Name        string `gorm:"size:255"`
	Email       string `gorm:"size:255"`
	Type        string `gorm:"size:64;index"`
	Provider    string `gorm:"size:64;index"`
	Label       string `gorm:"size:128"`
	Status      string `gorm:"size:64"`
	Source      string `gorm:"size:256"`
	Disabled    bool
	Unavailable bool
	RuntimeOnly bool
	UpdatedAt   time.Time
}

func (authFileModel) TableName() string { return "auth_files" }

type providerMetadataModel struct {
	ID           uint   `gorm:"primaryKey"`
	LookupKey    string `gorm:"uniqueIndex;size:256"`
	ProviderType string `gorm:"size:64;index"`
	DisplayName  string `gorm:"size:255"`
	ProviderKey  string `gorm:"size:128;index"`
	MatchKind    string `gorm:"size:32"`
	UpdatedAt    time.Time
}

func (providerMetadataModel) TableName() string { return "provider_metadata" }

type modelPriceSettingModel struct {
	ID                   uint    `gorm:"primaryKey"`
	Model                string  `gorm:"uniqueIndex;size:128"`
	PromptPricePer1M     float64 `gorm:"column:prompt_price_per_1m"`
	CompletionPricePer1M float64 `gorm:"column:completion_price_per_1m"`
	CachePricePer1M      float64 `gorm:"column:cache_price_per_1m"`
	UpdatedAt            time.Time
}

func (modelPriceSettingModel) TableName() string { return "model_price_settings" }

func allModels() []any {
	return []any{
		&usageEventModel{},
		&authFileModel{},
		&providerMetadataModel{},
		&modelPriceSettingModel{},
	}
}
