package storage

import "time"

// RequestKind caches classification of a log, never a unique usage execution.
type RequestKind struct {
	RequestID string    `json:"request_id"`
	Kind      string    `json:"kind"` // compact, contains_compact, normal, unknown
	Complete  bool      `json:"-"`
	CheckedAt time.Time `json:"-"`
}
