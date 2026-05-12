package api

import (
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/ingest"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"github.com/k0ngk0ng/cpa-usage/internal/usage"
)

// UsageDeps wires the usage handlers to the service layer.
type UsageDeps struct {
	Service   *usage.Service
	Store     storage.Store
	LogReader *cpa.LogReader
}

// maxImportBodyBytes caps the size of an uploaded export snapshot. The legacy
// CPA snapshot is in-memory JSON and bounded by RAM; 64MiB comfortably covers
// long-running instances with hundreds of thousands of details.
const maxImportBodyBytes = 64 << 20

func parseFilterFromQuery(c *gin.Context) (usage.Filter, error) {
	rangeKey := c.Query("range")
	startStr := c.Query("start")
	endStr := c.Query("end")
	models := c.QueryArray("model")
	sources := c.QueryArray("source")
	apiKeys := c.QueryArray("api_key")
	authIndex := c.Query("auth_index")
	result := c.Query("result")
	now := time.Now().In(time.Local)
	return usage.ParseFilter(rangeKey, startStr, endStr, models, sources, apiKeys, authIndex, result, now)
}

func usageOverviewHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		f, err := parseFilterFromQuery(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		out, err := deps.Service.Overview(c.Request.Context(), f)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func usageHealthHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		f, err := parseFilterFromQuery(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		out, err := deps.Service.Health(c.Request.Context(), f, c.Query("year"), c.Query("day"), time.Now().In(time.Local))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func usageAnalysisHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		f, err := parseFilterFromQuery(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		out, err := deps.Service.Analysis(c.Request.Context(), f)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func usageEventsHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		f, err := parseFilterFromQuery(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		size, _ := strconv.Atoi(c.DefaultQuery("page_size", strconv.Itoa(storage.DefaultPageSize)))
		out, err := deps.Service.Events(c.Request.Context(), f, usage.Page{Page: page, PageSize: size})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func usageEventFiltersHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		f, err := parseFilterFromQuery(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		out, err := deps.Service.EventFilters(c.Request.Context(), f)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func usageCredentialsHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		f, err := parseFilterFromQuery(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		out, err := deps.Service.Credentials(c.Request.Context(), f)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	}
}

// usageEventLogHandler reads the CPA per-request log file matching
// :request_id and returns structured sections (REQUEST INFO, HEADERS,
// REQUEST BODY, each API RESPONSE attempt with its status, and the final
// RESPONSE returned to the caller).
func usageEventLogHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if deps.LogReader == nil || deps.LogReader.Dir == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "CPA_LOG_DIR is not configured"})
			return
		}
		requestID := c.Param("request_id")
		path, err := deps.LogReader.FindLog(requestID)
		if err != nil {
			if errors.Is(err, cpa.ErrLogNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"found": false})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		entry, err := deps.LogReader.Read(path)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"found": true, "entry": entry})
	}
}

// usageImportHandler accepts a JSON snapshot exported from the legacy CPA
// `/v0/management/usage/export` endpoint and ingests its per-request details
// into the events store. event_keys are content-hashed so re-uploads are
// idempotent.
func usageImportHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if deps.Store == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "storage not configured"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxImportBodyBytes)
		raw, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "snapshot too large or read failed: " + err.Error()})
			return
		}
		env, err := ingest.DecodeSnapshot(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		events := ingest.SnapshotToEvents(env)
		if len(events) == 0 {
			c.JSON(http.StatusOK, gin.H{"added": 0, "skipped": 0, "total": 0})
			return
		}
		inserted, deduped, err := deps.Store.InsertUsageEvents(c.Request.Context(), events)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"added":       inserted,
			"skipped":     deduped,
			"total":       len(events),
			"exported_at": env.ExportedAt,
		})
	}
}

// usageBackfillHandler scans CPA_LOG_DIR for per-request log filenames and
// attaches a request_id (and endpoint hint) to imported events that still
// lack one. Idempotent: events already linked are not in the candidate set.
func usageBackfillHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if deps.Store == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "storage not configured"})
			return
		}
		if deps.LogReader == nil || deps.LogReader.Dir == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "CPA_LOG_DIR is not configured"})
			return
		}
		out, err := usage.Backfill(c.Request.Context(), deps.Store, deps.LogReader.Dir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

// usageEventLogRawHandler streams the raw CPA log file (unredacted by us; CPA
// itself already shortens credential-bearing headers) so users can download
// and inspect the original. Served as text/plain with a download disposition.
func usageEventLogRawHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if deps.LogReader == nil || deps.LogReader.Dir == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "CPA_LOG_DIR is not configured"})
			return
		}
		requestID := c.Param("request_id")
		path, err := deps.LogReader.FindLog(requestID)
		if err != nil {
			if errors.Is(err, cpa.ErrLogNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"found": false})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.Header("Content-Type", "text/plain; charset=utf-8")
		c.Header("Content-Disposition", `attachment; filename="`+filepath.Base(path)+`"`)
		c.File(path)
	}
}
