package storage

import "time"

// SessionLabel is evidence from a retained request log, not an inferred client title.
type SessionLabel struct {
	Title     string `json:"title"`
	Source    string `json:"source"` // generated_title or prompt_preview
	RequestID string `json:"request_id,omitempty"`
	More      bool   `json:"more"`
}

type RequestLabel struct {
	RequestID string
	Title     string
	Source    string
	Complete  bool
	CheckedAt time.Time
}
