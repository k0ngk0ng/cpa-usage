// Package redact provides identifier hashing + display-name masking for
// fields that may carry secrets (api_key) or user identifiers (source).
//
// `APIAlias` produces a stable, opaque alias keyed off SHA-256; `DisplayName`
// produces a human-friendly masked rendering ("sk-1***abcd"). Aliases are
// deterministic so the UI can group rows by alias safely.
package redact

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode/utf8"
)

const aliasPrefix = "redacted_api_"

// APIAlias returns a stable, opaque alias for the given identifier.
// Empty input becomes "unknown"; values already aliased are returned unchanged.
func APIAlias(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "unknown"
	}
	if trimmed == "unknown" || strings.HasPrefix(trimmed, aliasPrefix) {
		return trimmed
	}
	sum := sha256.Sum256([]byte(trimmed))
	return aliasPrefix + hex.EncodeToString(sum[:])[:12]
}

// DisplayName masks a credential string for display, preserving a few leading
// and trailing characters so operators can disambiguate keys at a glance.
func DisplayName(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || trimmed == "unknown" {
		return "unknown"
	}
	count := utf8.RuneCountInString(trimmed)
	if count <= 4 {
		return strings.Repeat("*", count)
	}
	if count <= 8 {
		runes := []rune(trimmed)
		return string(runes[:1]) + strings.Repeat("*", count-2) + string(runes[count-1:])
	}
	runes := []rune(trimmed)
	return string(runes[:4]) + strings.Repeat("*", count-8) + string(runes[count-4:])
}
