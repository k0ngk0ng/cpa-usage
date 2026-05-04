package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// AliasDeps wires alias-management handlers to storage.
type AliasDeps struct {
	Store storage.Store
}

// maxAliasImportBytes caps an /aliases/import upload. Aliases are tiny
// strings; even a generous 1MiB covers tens of thousands of entries.
const maxAliasImportBytes = 1 << 20

// aliasRequest is the body shape for PUT /aliases.
type aliasRequest struct {
	APIKey string `json:"api_key"`
	Alias  string `json:"alias"`
}

// aliasImportRequest is the body shape for POST /aliases/import.
//
// Mode "replace" wipes the alias table before inserting; "merge" (default)
// upserts each entry on top of the existing rows. The exported_at field
// from a previous /aliases/export is preserved on round-trip but ignored
// during import.
type aliasImportRequest struct {
	Mode       string                  `json:"mode"`
	ExportedAt time.Time               `json:"exported_at,omitempty"`
	Items      []aliasImportItem       `json:"items"`
}

type aliasImportItem struct {
	APIKey    string    `json:"api_key"`
	Alias     string    `json:"alias"`
	UpdatedAt time.Time `json:"updated_at,omitempty"`
}

func listAliasesHandler(deps AliasDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if deps.Store == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "storage not configured"})
			return
		}
		out, err := deps.Store.ListAPIKeyOverview(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	}
}

func upsertAliasHandler(deps AliasDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if deps.Store == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "storage not configured"})
			return
		}
		var req aliasRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if strings.TrimSpace(req.APIKey) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "api_key is required"})
			return
		}
		if err := deps.Store.UpsertAPIKeyAlias(c.Request.Context(), storage.APIKeyAlias{
			APIKey: req.APIKey,
			Alias:  req.Alias,
		}); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func deleteAliasHandler(deps AliasDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if deps.Store == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "storage not configured"})
			return
		}
		apiKey := strings.TrimSpace(c.Query("api_key"))
		if apiKey == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "api_key is required"})
			return
		}
		if err := deps.Store.DeleteAPIKeyAlias(c.Request.Context(), apiKey); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func exportAliasesHandler(deps AliasDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if deps.Store == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "storage not configured"})
			return
		}
		items, err := deps.Store.ListAPIKeyAliases(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"version":     1,
			"exported_at": time.Now().UTC(),
			"items":       items,
		})
	}
}

func importAliasesHandler(deps AliasDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if deps.Store == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "storage not configured"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAliasImportBytes)
		raw, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body too large"})
			return
		}
		var req aliasImportRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON: " + err.Error()})
			return
		}
		mode := strings.ToLower(strings.TrimSpace(req.Mode))
		if mode == "" {
			mode = "merge"
		}
		if mode != "merge" && mode != "replace" {
			c.JSON(http.StatusBadRequest, gin.H{"error": `mode must be "merge" or "replace"`})
			return
		}

		items := make([]storage.APIKeyAlias, 0, len(req.Items))
		for _, it := range req.Items {
			if strings.TrimSpace(it.APIKey) == "" || strings.TrimSpace(it.Alias) == "" {
				continue
			}
			items = append(items, storage.APIKeyAlias{
				APIKey:    it.APIKey,
				Alias:     it.Alias,
				UpdatedAt: it.UpdatedAt,
			})
		}

		ctx := c.Request.Context()
		applied := 0
		if mode == "replace" {
			if err := deps.Store.ReplaceAPIKeyAliases(ctx, items); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			applied = len(items)
		} else {
			for _, it := range items {
				if err := deps.Store.UpsertAPIKeyAlias(ctx, it); err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
					return
				}
				applied++
			}
		}
		c.JSON(http.StatusOK, gin.H{
			"mode":     mode,
			"applied":  applied,
			"received": len(req.Items),
		})
	}
}
