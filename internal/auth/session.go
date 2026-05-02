// Package auth implements an in-memory session manager for the optional password
// login flow. Sessions are opaque random tokens kept in process memory; the
// process restarting invalidates everyone (acceptable for v1).
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"sync"
	"time"
)

// SessionManager tracks live sessions and their expiry.
type SessionManager struct {
	ttl      time.Duration
	now      func() time.Time
	generate func() (string, error)

	mu       sync.RWMutex
	sessions map[string]time.Time
}

// NewSessionManager builds a SessionManager with the supplied TTL.
func NewSessionManager(ttl time.Duration) *SessionManager {
	return &SessionManager{
		ttl:      ttl,
		now:      time.Now,
		generate: generateToken,
		sessions: make(map[string]time.Time),
	}
}

// Create issues a new session and returns the token + absolute expiry.
func (m *SessionManager) Create() (string, time.Time, error) {
	token, err := m.generate()
	if err != nil {
		return "", time.Time{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleanupLocked()
	expires := m.now().Add(m.ttl)
	m.sessions[token] = expires
	return token, expires, nil
}

// Validate reports whether token is a known, unexpired session.
func (m *SessionManager) Validate(token string) bool {
	if token == "" {
		return false
	}
	m.mu.RLock()
	expires, ok := m.sessions[token]
	m.mu.RUnlock()
	if !ok {
		return false
	}
	if !expires.After(m.now()) {
		m.Delete(token)
		return false
	}
	return true
}

// Delete removes a session by token. No-op if the token is absent.
func (m *SessionManager) Delete(token string) {
	if token == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, token)
}

// CleanupExpired drops sessions whose expiry has passed.
func (m *SessionManager) CleanupExpired() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleanupLocked()
}

// TTL returns the configured TTL (used to set cookie max-age).
func (m *SessionManager) TTL() time.Duration { return m.ttl }

// PasswordMatches performs a constant-time compare on the supplied password.
func PasswordMatches(expected, supplied string) bool {
	if expected == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(supplied)) == 1
}

func (m *SessionManager) cleanupLocked() {
	now := m.now()
	for tok, exp := range m.sessions {
		if !exp.After(now) {
			delete(m.sessions, tok)
		}
	}
}

func generateToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
