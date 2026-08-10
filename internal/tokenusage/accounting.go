// Package tokenusage contains the provider-aware compatibility rules used for
// CPA records that predate canonical token accounting v2.
package tokenusage

import "strings"

// AccountingVersionV2 is the canonical token accounting version emitted by
// CLIProxyAPI v7.2.97 and newer.
const AccountingVersionV2 = 2

// Style describes how legacy provider counters overlap.
type Style uint8

const (
	StyleUnknown Style = iota
	// StyleSubset means cache is included in input and reasoning is included in output.
	StyleSubset
	// StyleIndependent means cache is separate from input while reasoning is included in output.
	StyleIndependent
	// StyleSeparateReasoning means cache is included in input and reasoning is separate from output.
	StyleSeparateReasoning
)

// StyleFor classifies legacy counters from executor/provider metadata only.
// Executor type deliberately wins over provider so a routed model name or a
// misleading provider label cannot override the implementation that parsed it.
func StyleFor(provider, executorType string) Style {
	executor := normalize(executorType)
	if executor != "" && executor != "unknown" {
		if style := styleForExecutor(executor); style != StyleUnknown {
			return style
		}
	}

	provider = normalize(provider)
	if provider == "" || provider == "unknown" {
		return StyleUnknown
	}
	if provider == "openai-compatibility" || strings.HasPrefix(provider, "openai-compatible-") {
		return StyleSubset
	}
	return styleForProvider(provider)
}

// OutputTotal returns a consistent output total for stored rows. Canonical v2
// already supplies the total; Gemini-family legacy counters require reasoning
// to be added to their non-reasoning output counter.
func OutputTotal(accountingVersion int, accountingQuality, provider, executorType string, output, reasoning int64) int64 {
	if IsCanonicalV2(accountingVersion, accountingQuality) || StyleFor(provider, executorType) != StyleSeparateReasoning {
		return output
	}
	if output < 0 || reasoning <= 0 || output > maxInt64-reasoning {
		return output
	}
	return output + reasoning
}

// IsCanonicalV2 reports whether stored counters came from a validated v2
// breakdown rather than merely claiming the version number.
func IsCanonicalV2(accountingVersion int, accountingQuality string) bool {
	if accountingVersion != AccountingVersionV2 {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(accountingQuality)) {
	case "complete", "inconsistent", "unclassified":
		return true
	default:
		return false
	}
}

// LegacyNonReasoning returns the best known non-reasoning output for a legacy
// record. Unknown styles with an explicit reasoning bucket remain unclassified.
func LegacyNonReasoning(provider, executorType string, output, reasoning int64) int64 {
	switch StyleFor(provider, executorType) {
	case StyleSubset, StyleIndependent:
		return subtractFloor(output, reasoning)
	case StyleSeparateReasoning:
		return output
	default:
		if reasoning == 0 {
			return output
		}
		return 0
	}
}

func styleForExecutor(executor string) Style {
	switch executor {
	case "claudeexecutor":
		return StyleIndependent
	case "geminiexecutor", "geminivertexexecutor", "aistudioexecutor", "antigravityexecutor":
		return StyleSeparateReasoning
	case "openaicompatexecutor",
		"codexexecutor", "codexwebsocketsexecutor", "codexautoexecutor",
		"xaiexecutor", "xaiwebsocketsexecutor", "xaiautoexecutor",
		"kimiexecutor":
		return StyleSubset
	default:
		return StyleUnknown
	}
}

func styleForProvider(provider string) Style {
	switch provider {
	case "claude", "anthropic":
		return StyleIndependent
	case "gemini", "gemini-interactions", "interactions", "aistudio", "antigravity", "vertex":
		return StyleSeparateReasoning
	case "openai", "codex", "xai", "grok", "kimi", "qwen", "deepseek", "openrouter":
		return StyleSubset
	default:
		return StyleUnknown
	}
}

func normalize(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func subtractFloor(value, delta int64) int64 {
	if value <= 0 {
		return 0
	}
	if delta <= 0 {
		return value
	}
	if value <= delta {
		return 0
	}
	return value - delta
}

const maxInt64 = int64(^uint64(0) >> 1)
