package api

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/drain"
	"github.com/k0ngk0ng/cpa-usage/internal/redact"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// MetaDeps wires the metadata-related handlers to their dependencies.
type MetaDeps struct {
	Store   storage.Store
	Drain   *drain.Drain
	CPA     *cpa.Client
	SyncNow func(ctx context.Context) error
}

func authFilesHandler(deps MetaDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		out, err := deps.Store.ListAuthFiles(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		for i := range out {
			out[i].Source = redact.DisplayName(out[i].Source)
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	}
}

func providerMetadataHandler(deps MetaDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		out, err := deps.Store.ListProviderMetadata(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		for i := range out {
			// LookupKey carries a raw api_key when MatchKind=="api_key"; replace
			// with a stable alias so the UI keeps a unique rowKey without leaking
			// the secret. Prefix entries are non-sensitive and left intact.
			if out[i].MatchKind == "api_key" {
				out[i].LookupKey = redact.APIAlias(out[i].LookupKey)
			}
			out[i].ProviderKey = redact.DisplayName(out[i].ProviderKey)
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	}
}

func usedModelsHandler(deps MetaDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		used, err := deps.Store.ListUsedModels(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		seen := make(map[string]struct{}, len(used))
		out := make([]string, 0, len(used))
		for _, m := range used {
			m = strings.TrimSpace(m)
			if m == "" {
				continue
			}
			if _, ok := seen[m]; ok {
				continue
			}
			seen[m] = struct{}{}
			out = append(out, m)
		}
		if deps.CPA != nil {
			if items, err := deps.CPA.FetchModels(c.Request.Context()); err == nil {
				for _, mi := range items {
					id := strings.TrimSpace(mi.ID)
					if id == "" {
						continue
					}
					if _, ok := seen[id]; ok {
						continue
					}
					seen[id] = struct{}{}
					out = append(out, id)
				}
			}
		}
		sort.Strings(out)
		c.JSON(http.StatusOK, gin.H{"items": out})
	}
}

func statusHandler(deps MetaDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var status drain.Status
		if deps.Drain != nil {
			status = deps.Drain.Status()
		}
		c.JSON(http.StatusOK, gin.H{
			"redis_address":         status.RedisAddress,
			"last_pop_at":           status.LastPopAt,
			"last_inserted_at":      status.LastInsertedAt,
			"last_error_at":         status.LastErrorAt,
			"last_error":            status.LastError,
			"last_metadata_sync_at": status.LastMetadataSyncAt,
			"last_metadata_error":   status.LastMetadataError,
			"total_inserted":        status.TotalInserted,
			"total_deduped":         status.TotalDeduped,
			"total_decode_errors":   status.TotalDecodeErrors,
			"batches_popped":        status.BatchesPopped,
		})
	}
}

func syncHandler(deps MetaDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if deps.SyncNow == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sync not available"})
			return
		}
		if err := deps.SyncNow(c.Request.Context()); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
