package tokenusage

import "testing"

func TestStyleForPrefersExecutorAndUsesExactProviders(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		executor string
		want     Style
	}{
		{name: "antigravity", provider: "antigravity", executor: "AntigravityExecutor", want: StyleSeparateReasoning},
		{name: "claude executor", provider: "custom", executor: "ClaudeExecutor", want: StyleIndependent},
		{name: "compat overrides provider", provider: "anthropic", executor: "OpenAICompatExecutor", want: StyleSubset},
		{name: "gemini executor overrides provider", provider: "anthropic", executor: "GeminiExecutor", want: StyleSeparateReasoning},
		{name: "provider fallback", provider: "openai-compatible-acme", want: StyleSubset},
		{name: "exact Claude provider fallback", provider: "claude", executor: "CustomExecutor", want: StyleIndependent},
		{name: "provider substring is not enough", provider: "my-claude-gateway", want: StyleUnknown},
		{name: "executor substring is not enough", provider: "custom", executor: "MyClaudeExecutor", want: StyleUnknown},
		{name: "unknown", provider: "custom", executor: "CustomExecutor", want: StyleUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := StyleFor(tt.provider, tt.executor); got != tt.want {
				t.Fatalf("StyleFor(%q, %q) = %v, want %v", tt.provider, tt.executor, got, tt.want)
			}
		})
	}
}

func TestOutputTotalNormalizesLegacySeparateReasoningOnly(t *testing.T) {
	if got := OutputTotal(0, "legacy", "gemini", "GeminiExecutor", 30, 12); got != 42 {
		t.Fatalf("legacy Gemini output = %d, want 42", got)
	}
	if got := OutputTotal(0, "legacy", "openai", "CodexExecutor", 42, 12); got != 42 {
		t.Fatalf("legacy OpenAI output = %d, want 42", got)
	}
	if got := OutputTotal(AccountingVersionV2, "complete", "gemini", "GeminiExecutor", 42, 12); got != 42 {
		t.Fatalf("canonical Gemini output = %d, want 42", got)
	}
}
