package storage

// TimelineSummary describes an observed usage envelope, not an HTTP root span.
type TimelineSummary struct {
	Key          string `json:"key"`
	Kind         string `json:"kind"`
	LastAtMs     int64  `json:"last_at_ms"`
	StartedAtMs  int64  `json:"started_at_ms"`
	EndedAtMs    int64  `json:"ended_at_ms"`
	Records      int64  `json:"records"`
	Failed       int64  `json:"failed"`
	TotalTokens  int64  `json:"total_tokens"`
	ModelCount   int64  `json:"model_count"`
	Model        string `json:"model"`
	RequestCount int64  `json:"request_count"`
}

type TimelinePage struct {
	Items    []TimelineSummary `json:"items"`
	Total    int64             `json:"total"`
	Page     int               `json:"page"`
	PageSize int               `json:"page_size"`
}

// TimelineDetail is an insertion-ID snapshot. Later pages exclude new arrivals,
// including delayed records whose timestamp precedes records already loaded.
type TimelineDetail struct {
	Summary            TimelineSummary       `json:"summary"`
	Items              []UsageEventRecord    `json:"items"`
	Snapshot           uint64                `json:"snapshot"`
	NextCursor         uint64                `json:"next_cursor"`
	ReferencedOnly     bool                  `json:"referenced_only"`
	Sessions           []TimelineSessionLink `json:"sessions"`
	Parents            []TimelineSessionLink `json:"parent_sessions"`
	ChildSessions      int64                 `json:"child_sessions"`
	ReferencingRecords int64                 `json:"referencing_records"`
	FocusedEvent       *UsageEventRecord     `json:"focused_event,omitempty"`
}

// TimelineSessionLink distinguishes an observed relationship from own usage.
type TimelineSessionLink struct {
	ID         string `json:"id"`
	HasRecords bool   `json:"has_records"`
}
