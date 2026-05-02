package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/k0ngk0ng/cpa-usage/internal/auth"
)

// AuthDeps wires together the auth handler/middleware dependencies.
type AuthDeps struct {
	Enabled       bool
	Password      string
	CookieName    string
	BasePath      string
	Sessions      *auth.SessionManager
}

// loginRequest is the JSON body of POST /auth/login.
type loginRequest struct {
	Password string `json:"password"`
}

// sessionResponse describes the public session shape (no token).
type sessionResponse struct {
	Authenticated bool `json:"authenticated"`
	AuthRequired  bool `json:"auth_required"`
}

func sessionHandler(deps AuthDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ok := true
		if deps.Enabled {
			token := readSessionToken(c, deps.CookieName)
			ok = token != "" && deps.Sessions.Validate(token)
		}
		c.JSON(http.StatusOK, sessionResponse{Authenticated: ok, AuthRequired: deps.Enabled})
	}
}

func loginHandler(deps AuthDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !deps.Enabled {
			c.JSON(http.StatusOK, sessionResponse{Authenticated: true, AuthRequired: false})
			return
		}
		var req loginRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
			return
		}
		if !auth.PasswordMatches(deps.Password, req.Password) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid password"})
			return
		}
		token, expires, err := deps.Sessions.Create()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "session creation failed"})
			return
		}
		setSessionCookie(c, deps, token, int(deps.Sessions.TTL().Seconds()))
		c.JSON(http.StatusOK, gin.H{"authenticated": true, "expires_at": expires})
	}
}

func logoutHandler(deps AuthDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := readSessionToken(c, deps.CookieName)
		if token != "" {
			deps.Sessions.Delete(token)
		}
		setSessionCookie(c, deps, "", -1)
		c.JSON(http.StatusOK, gin.H{"authenticated": false})
	}
}

// authMiddleware returns a gin middleware enforcing session presence when auth
// is enabled. When auth is disabled the middleware is a no-op.
func authMiddleware(deps AuthDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !deps.Enabled {
			c.Next()
			return
		}
		token := readSessionToken(c, deps.CookieName)
		if token == "" || !deps.Sessions.Validate(token) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}
		c.Next()
	}
}

func readSessionToken(c *gin.Context, cookieName string) string {
	v, err := c.Cookie(cookieName)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(v)
}

func setSessionCookie(c *gin.Context, deps AuthDeps, token string, maxAge int) {
	cookiePath := deps.BasePath
	if cookiePath == "" {
		cookiePath = "/"
	}
	secure := strings.EqualFold(strings.ToLower(c.Request.URL.Scheme), "https") || c.Request.TLS != nil
	c.SetCookie(deps.CookieName, token, maxAge, cookiePath, "", secure, true)
}
