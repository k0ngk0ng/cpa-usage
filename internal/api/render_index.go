package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/k0ngk0ng/cpa-usage/web"
)

// indexPlaceholder is the JS literal token replaced with the base path.
const indexPlaceholder = `"__APP_BASE_PATH__"`

// baseTagPlaceholder is replaced with a literal <base> tag at request time.
// It lives in the HTML head BEFORE any asset references so the browser's
// speculative preload sees the right base for relative URLs (./assets/...).
const baseTagPlaceholder = `<!--__BASE_TAG__-->`

// devPlaceholderHTML is served when web/dist/index.html is missing — i.e. the
// SPA bundle has not been built yet. This keeps `go build` working from a
// fresh clone without forcing a Node toolchain on every dev cycle.
const devPlaceholderHTML = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>cpa-usage</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1rem;color:#333}code{background:#f4f4f5;padding:.1em .35em;border-radius:.25rem}</style>
</head><body>
<h1>cpa-usage</h1>
<p>The SPA bundle is not embedded. Build it once before running the server:</p>
<pre><code>cd web &amp;&amp; npm ci &amp;&amp; npm run build</code></pre>
<p>Release builds run this automatically via goreleaser.</p>
</body></html>
`

// renderIndex reads dist/index.html from the embedded FS and substitutes the
// runtime base path placeholder so the SPA can build correct asset URLs.
// If the SPA has not been built (dist/index.html missing), returns a static
// placeholder page instead of an error.
func renderIndex(basePath string) ([]byte, error) {
	embedded := web.FS()
	raw, err := fs.ReadFile(embedded, "dist/index.html")
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []byte(devPlaceholderHTML), nil
		}
		return nil, err
	}
	encoded, err := json.Marshal(basePath)
	if err != nil {
		return nil, err
	}
	out := bytes.ReplaceAll(raw, []byte(indexPlaceholder), encoded)
	baseTag := ""
	if basePath != "" {
		baseTag = fmt.Sprintf(`<base href="%s/">`, html.EscapeString(basePath))
	}
	out = bytes.ReplaceAll(out, []byte(baseTagPlaceholder), []byte(baseTag))
	return out, nil
}

// distFS returns a sub-filesystem rooted at dist/ for static asset serving.
func distFS() (fs.FS, error) {
	embedded := web.FS()
	return fs.Sub(embedded, "dist")
}

// serveSPA serves static assets first; falling back to the rendered index for
// any other path so React Router catch-all works.
func serveSPA(basePath string) gin.HandlerFunc {
	sub, err := distFS()
	return func(c *gin.Context) {
		if err != nil {
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		rel := strings.TrimPrefix(c.Request.URL.Path, basePath)
		rel = strings.TrimPrefix(rel, "/")
		if rel == "" {
			renderAndWriteIndex(c, basePath)
			return
		}
		clean := path.Clean(rel)
		if strings.HasPrefix(clean, "..") {
			c.AbortWithStatus(http.StatusBadRequest)
			return
		}
		f, err := sub.Open(clean)
		if err != nil {
			renderAndWriteIndex(c, basePath)
			return
		}
		stat, err := f.Stat()
		_ = f.Close()
		if err != nil || stat.IsDir() {
			renderAndWriteIndex(c, basePath)
			return
		}
		http.ServeFileFS(c.Writer, c.Request, sub, clean)
	}
}

func renderAndWriteIndex(c *gin.Context, basePath string) {
	body, err := renderIndex(basePath)
	if err != nil {
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	c.Data(http.StatusOK, "text/html; charset=utf-8", body)
}
