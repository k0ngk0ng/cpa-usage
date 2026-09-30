package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// Discovery is separate from usage queries: slow/missing logs never hold up
// the session list. Work is bounded, deduplicated in SQLite, and resumable.
func usageSessionLabelHandler(deps UsageDeps) gin.HandlerFunc {
	slots := make(chan struct{}, 2)
	return func(c *gin.Context) {
		id := strings.TrimSpace(c.Query("session_id"))
		if id == "" || len(id) > 2048 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "valid session_id is required"})
			return
		}
		// Previously discovered names stay available even when CPA is slow.
		if c.Query("cached") == "1" {
			label, err := deps.Store.SessionLabel(c.Request.Context(), id)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, label)
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 12*time.Second)
		defer cancel()
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		case <-ctx.Done():
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "title lookup busy; try again"})
			return
		}
		label, err := deps.Store.SessionLabel(ctx, id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if !eventLogSourceConfigured(deps) {
			c.JSON(http.StatusOK, label)
			return
		}
		ids, err := deps.Store.SessionLabelCandidates(ctx, id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		for _, requestID := range ids {
			if ctx.Err() != nil {
				break
			}
			title, source := "", ""
			handle, err := resolveEventLog(ctx, deps, requestID, 8<<20)
			if err == nil {
				// Large normal transcripts stay readable on demand, but are not scanned
				// for labels while browsing cards. Naming requests are typically small.
				if handle.fileSize <= 8<<20 {
					reader := *eventLogReader(deps)
					reader.MaxBodyBytes = 2 << 20
					entry, readErr := reader.Read(handle.path)
					if readErr == nil {
						title, source = cpa.SessionLabelFromLog(entry)
					}
				}
				handle.Close()
			}
			if ctx.Err() != nil {
				break
			}
			if err := deps.Store.SaveRequestLabel(ctx, storage.RequestLabel{RequestID: requestID, Title: title, Source: source, Complete: title != ""}); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		}
		// Use the HTTP lifetime for the final cached result if the discovery budget
		// expired. Unchecked requests can be resumed in a subsequent batch.
		ctx = c.Request.Context()
		label, err = deps.Store.SessionLabel(ctx, id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		remaining, err := deps.Store.SessionLabelCandidates(ctx, id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		label.More = len(remaining) > 0 && label.Source != "generated_title"
		c.JSON(http.StatusOK, label)
	}
}
