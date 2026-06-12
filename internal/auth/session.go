// Package auth implements the optional password login flow. Successful logins
// receive stateless JWTs signed from the configured login password, so process
// restarts do not invalidate existing browser cookies.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// TokenManager issues and validates stateless JWTs.
type TokenManager struct {
	ttl time.Duration
	key []byte
	now func() time.Time
}

type jwtClaims struct {
	Subject   string `json:"sub"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// NewTokenManager builds a TokenManager with the supplied TTL and signing
// secret. Tokens remain valid across process restarts as long as the secret
// (currently the login password) is unchanged.
func NewTokenManager(ttl time.Duration, secret string) *TokenManager {
	key := sha256.Sum256([]byte("cpa-usage jwt signing key\x00" + secret))
	return &TokenManager{
		ttl: ttl,
		key: key[:],
		now: time.Now,
	}
}

// Create issues a new JWT and returns the token + absolute expiry.
func (m *TokenManager) Create() (string, time.Time, error) {
	now := m.now()
	expires := now.Add(m.ttl)

	header, err := json.Marshal(map[string]string{
		"alg": "HS256",
		"typ": "JWT",
	})
	if err != nil {
		return "", time.Time{}, err
	}
	claims, err := json.Marshal(jwtClaims{
		Subject:   "cpa-usage",
		IssuedAt:  now.Unix(),
		ExpiresAt: expires.Unix(),
	})
	if err != nil {
		return "", time.Time{}, err
	}

	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	return unsigned + "." + m.sign(unsigned), expires, nil
}

// Validate reports whether token is a well-formed, signed, unexpired JWT.
func (m *TokenManager) Validate(token string) bool {
	if token == "" {
		return false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}

	unsigned := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(parts[2]), []byte(m.sign(unsigned))) {
		return false
	}

	claimsRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims jwtClaims
	if err := json.Unmarshal(claimsRaw, &claims); err != nil {
		return false
	}
	if claims.Subject != "cpa-usage" || claims.ExpiresAt <= 0 {
		return false
	}
	return time.Unix(claims.ExpiresAt, 0).After(m.now())
}

// TTL returns the configured TTL (used to set cookie max-age).
func (m *TokenManager) TTL() time.Duration { return m.ttl }

// PasswordMatches performs a constant-time compare on the supplied password.
func PasswordMatches(expected, supplied string) bool {
	if expected == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(supplied)) == 1
}

func (m *TokenManager) sign(unsigned string) string {
	mac := hmac.New(sha256.New, m.key)
	_, _ = mac.Write([]byte(unsigned))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
