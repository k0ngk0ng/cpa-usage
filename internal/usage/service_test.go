package usage

import (
	"testing"
	"time"
)

func TestParseFilterCustomAcceptsDatetimeLocalMinutePrecision(t *testing.T) {
	oldLocal := time.Local
	loc := time.FixedZone("UTC+8", 8*60*60)
	time.Local = loc
	defer func() { time.Local = oldLocal }()

	f, err := ParseFilter("custom", "2016-02-21T00:00", "2016-02-21T23:59", nil, nil, nil, "", "", "", time.Now())
	if err != nil {
		t.Fatalf("ParseFilter returned error: %v", err)
	}

	wantStart := time.Date(2016, time.February, 21, 0, 0, 0, 0, loc)
	wantEnd := time.Date(2016, time.February, 21, 23, 59, 0, 0, loc)
	if !f.Start.Equal(wantStart) {
		t.Fatalf("start = %v, want %v", f.Start, wantStart)
	}
	if !f.End.Equal(wantEnd) {
		t.Fatalf("end = %v, want %v", f.End, wantEnd)
	}
}

func TestParseFilterDayRanges(t *testing.T) {
	loc := time.FixedZone("UTC+8", 8*60*60)
	now := time.Date(2026, time.May, 26, 15, 4, 0, 0, loc)

	tests := []struct {
		name      string
		rangeKey  string
		wantStart time.Time
		wantEnd   time.Time
	}{
		{
			name:      "2d",
			rangeKey:  "2d",
			wantStart: time.Date(2026, time.May, 25, 0, 0, 0, 0, loc),
			wantEnd:   time.Date(2026, time.May, 27, 0, 0, 0, 0, loc),
		},
		{
			name:      "3d",
			rangeKey:  "3d",
			wantStart: time.Date(2026, time.May, 24, 0, 0, 0, 0, loc),
			wantEnd:   time.Date(2026, time.May, 27, 0, 0, 0, 0, loc),
		},
		{
			name:      "4d",
			rangeKey:  "4d",
			wantStart: time.Date(2026, time.May, 23, 0, 0, 0, 0, loc),
			wantEnd:   time.Date(2026, time.May, 27, 0, 0, 0, 0, loc),
		},
		{
			name:      "5d",
			rangeKey:  "5d",
			wantStart: time.Date(2026, time.May, 22, 0, 0, 0, 0, loc),
			wantEnd:   time.Date(2026, time.May, 27, 0, 0, 0, 0, loc),
		},
		{
			name:      "6d",
			rangeKey:  "6d",
			wantStart: time.Date(2026, time.May, 21, 0, 0, 0, 0, loc),
			wantEnd:   time.Date(2026, time.May, 27, 0, 0, 0, 0, loc),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f, err := ParseFilter(tc.rangeKey, "", "", nil, nil, nil, "", "", "", now)
			if err != nil {
				t.Fatalf("ParseFilter returned error: %v", err)
			}
			if !f.Start.Equal(tc.wantStart) {
				t.Fatalf("start = %v, want %v", f.Start, tc.wantStart)
			}
			if !f.End.Equal(tc.wantEnd) {
				t.Fatalf("end = %v, want %v", f.End, tc.wantEnd)
			}
		})
	}
}

func TestParseFilterTrimsRequestID(t *testing.T) {
	f, err := ParseFilter("all", "", "", nil, nil, nil, "", "", " req_123 ", time.Now())
	if err != nil {
		t.Fatalf("ParseFilter returned error: %v", err)
	}
	if f.RequestID != "req_123" {
		t.Fatalf("request id = %q, want %q", f.RequestID, "req_123")
	}
}
