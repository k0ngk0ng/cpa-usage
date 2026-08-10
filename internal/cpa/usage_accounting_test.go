package cpa

import "testing"

func TestTokenBreakdownValid(t *testing.T) {
	valid := TokenBreakdown{
		SchemaVersion: 2,
		Quality:       "complete",
		TotalTokens:   142,
		Input: TokenInputBreakdown{
			TotalTokens:     100,
			UncachedTokens:  20,
			CacheReadTokens: 80,
		},
		Output: TokenOutputBreakdown{
			TotalTokens:        42,
			NonReasoningTokens: 30,
			ReasoningTokens:    12,
		},
	}
	if !valid.Valid() {
		t.Fatalf("valid breakdown rejected: %+v", valid)
	}

	tests := []struct {
		name   string
		mutate func(*TokenBreakdown)
	}{
		{name: "schema", mutate: func(b *TokenBreakdown) { b.SchemaVersion = 3 }},
		{name: "quality", mutate: func(b *TokenBreakdown) { b.Quality = "unknown" }},
		{name: "input sum", mutate: func(b *TokenBreakdown) { b.Input.UncachedTokens++ }},
		{name: "output sum", mutate: func(b *TokenBreakdown) { b.Output.ReasoningTokens++ }},
		{name: "grand total", mutate: func(b *TokenBreakdown) { b.TotalTokens++ }},
		{name: "complete unclassified", mutate: func(b *TokenBreakdown) { b.UnclassifiedTokens = 1; b.TotalTokens++ }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := valid
			tt.mutate(&got)
			if got.Valid() {
				t.Fatalf("invalid breakdown accepted: %+v", got)
			}
		})
	}
}
