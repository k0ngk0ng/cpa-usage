package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func healthHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	}
}

func pingHandler(version string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"pong": true, "version": version})
	}
}

// versionHandler returns the cpa-usage build info (from ldflags) alongside the
// most recently observed CPA build identifiers (captured from response headers
// on management calls).
func versionHandler(build BuildInfo, meta MetaDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		out := gin.H{
			"cpa_usage": gin.H{
				"version":    build.Version,
				"commit":     build.Commit,
				"build_date": build.BuildDate,
			},
		}
		if meta.CPA != nil {
			v := meta.CPA.Version()
			out["cpa"] = gin.H{
				"version":    v.Version,
				"commit":     v.Commit,
				"build_date": v.BuildDate,
			}
		} else {
			out["cpa"] = gin.H{"version": "", "commit": "", "build_date": ""}
		}
		c.JSON(http.StatusOK, out)
	}
}
