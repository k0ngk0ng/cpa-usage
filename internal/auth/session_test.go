package auth

import (
	"strings"
	"testing"
	"time"
)

func TestTokenManagerValidatesAcrossInstances(t *testing.T) {
	now := time.Date(2026, 6, 12, 10, 0, 0, 0, time.UTC)
	m1 := NewTokenManager(time.Hour, "secret")
	m1.now = func() time.Time { return now }

	token, expires, err := m1.Create()
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got, want := strings.Count(token, "."), 2; got != want {
		t.Fatalf("token dot count = %d, want %d", got, want)
	}
	if !expires.Equal(now.Add(time.Hour)) {
		t.Fatalf("expires = %s, want %s", expires, now.Add(time.Hour))
	}

	m2 := NewTokenManager(time.Hour, "secret")
	m2.now = func() time.Time { return now.Add(30 * time.Minute) }
	if !m2.Validate(token) {
		t.Fatal("Validate returned false for token signed by another manager instance")
	}
}

func TestTokenManagerRejectsWrongSecret(t *testing.T) {
	now := time.Date(2026, 6, 12, 10, 0, 0, 0, time.UTC)
	m1 := NewTokenManager(time.Hour, "secret")
	m1.now = func() time.Time { return now }
	token, _, err := m1.Create()
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	m2 := NewTokenManager(time.Hour, "other-secret")
	m2.now = func() time.Time { return now }
	if m2.Validate(token) {
		t.Fatal("Validate returned true for token signed with a different secret")
	}
}

func TestTokenManagerRejectsExpiredToken(t *testing.T) {
	now := time.Date(2026, 6, 12, 10, 0, 0, 0, time.UTC)
	m := NewTokenManager(time.Hour, "secret")
	m.now = func() time.Time { return now }
	token, _, err := m.Create()
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	m.now = func() time.Time { return now.Add(time.Hour + time.Second) }
	if m.Validate(token) {
		t.Fatal("Validate returned true for expired token")
	}
}
