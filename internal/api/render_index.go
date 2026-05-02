package api

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/k0ngk0ng/cpa-usage/web"
)

// indexPlaceholder is the literal token replaced at runtime with the basePath.
const indexPlaceholder = `"__APP_BASE_PATH__"`

// renderIndex reads dist/index.html from the embedded FS and substitutes the
// runtime base path placeholder so the SPA can build correct asset URLs.
func renderIndex(basePath string) ([]byte, error) {
	embedded := web.FS()
	raw, err := fs.ReadFile(embedded, "dist/index.html")
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(basePath)
	if err != nil {
		return nil, err
	}
	return bytes.ReplaceAll(raw, []byte(indexPlaceholder), encoded), nil
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
