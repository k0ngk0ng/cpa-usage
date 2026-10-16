package api

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"golang.org/x/sync/singleflight"
)

// Separate from the events query so remote log latency cannot block the list.
// Each request scans at most eight retained logs, each bounded to 8 MiB, with
// two concurrent batches and a cooldown for unavailable/incomplete evidence.
func usageRequestKindsHandler(deps UsageDeps) gin.HandlerFunc {
	slots := make(chan struct{}, 2)
	var flights singleflight.Group
	return func(c *gin.Context) {
		var input struct {
			RequestIDs []string `json:"request_ids"`
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
		if err := c.ShouldBindJSON(&input); err != nil || len(input.RequestIDs) == 0 || len(input.RequestIDs) > 8 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "request_ids must contain between 1 and 8 IDs"})
			return
		}
		ids := make([]string, 0, len(input.RequestIDs))
		seen := map[string]bool{}
		for _, id := range input.RequestIDs {
			if err := cpa.ValidateRequestID(id); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request ID"})
				return
			}
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		if deps.Store == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "storage not configured"})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 12*time.Second)
		defer cancel()
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		case <-ctx.Done():
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "request type lookup busy"})
			return
		}
		kinds, err := deps.Store.RequestKinds(ctx, ids)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if eventLogSourceConfigured(deps) {
			for _, id := range ids {
				cached, exists := kinds[id]
				if !exists || cached.Complete || time.Since(cached.CheckedAt) < 5*time.Minute {
					continue
				}
				if ctx.Err() != nil {
					break
				}
				_, err, _ := flights.Do(id, func() (any, error) {
					return nil, discoverRequestKind(ctx, deps, id)
				})
				if err != nil && ctx.Err() == nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
					return
				}
			}
		}
		kinds, err = deps.Store.RequestKinds(c.Request.Context(), ids)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": kinds})
	}
}

func discoverRequestKind(ctx context.Context, deps UsageDeps, id string) error {
	// Recheck after waiting for another client or batch to finish.
	cached, err := deps.Store.RequestKinds(ctx, []string{id})
	if err != nil {
		return err
	}
	previous, exists := cached[id]
	if !exists || previous.Complete || time.Since(previous.CheckedAt) < 5*time.Minute {
		return nil
	}
	result := storage.RequestKind{RequestID: id, Kind: "unknown"}
	handle, err := resolveEventLog(ctx, deps, id, 8<<20)
	if err == nil {
		defer handle.Close()
		if handle.fileSize <= 8<<20 {
			reader := *eventLogReader(deps)
			reader.MaxBodyBytes = 8 << 20
			if entry, readErr := reader.Read(handle.path); readErr == nil {
				result.Kind, result.Complete = cpa.RequestKindFromLog(entry)
			}
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return deps.Store.SaveRequestKind(ctx, result)
}
