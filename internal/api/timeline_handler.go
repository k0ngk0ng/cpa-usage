package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/k0ngk0ng/cpa-usage/internal/usage"
	"gorm.io/gorm"
)

func usageTimelinesHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		f, err := parseFilterFromQuery(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		mode := c.DefaultQuery("mode", "request")
		if mode != "request" && mode != "session" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "mode must be request or session"})
			return
		}
		page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
		if err != nil || page < 1 || page > 1000000 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid page"})
			return
		}
		out, err := deps.Service.Timelines(c.Request.Context(), f, mode, usage.Page{Page: page, PageSize: 20})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func usageTimelineDetailHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := c.Query("key")
		kind, id, ok := strings.Cut(key, ":")
		if !ok || id == "" || len(key) > 2048 || (kind != "session" && kind != "request" && kind != "event") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid timeline key"})
			return
		}
		cursor, errCursor := strconv.ParseUint(c.DefaultQuery("cursor", "0"), 10, 63)
		snapshot, errSnapshot := strconv.ParseUint(c.DefaultQuery("snapshot", "0"), 10, 63)
		if errCursor != nil || errSnapshot != nil || (cursor > 0 && (snapshot == 0 || cursor > snapshot)) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid timeline cursor"})
			return
		}
		out, err := deps.Service.TimelineDetail(c.Request.Context(), key, cursor, snapshot, c.Query("focus_event"))
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": kind + " not found in retained usage records"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func usageSessionRequestsHandler(deps UsageDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := strings.TrimSpace(c.Query("session_id"))
		snapshot, errSnapshot := strconv.ParseUint(c.Query("snapshot"), 10, 63)
		page, errPage := strconv.Atoi(c.DefaultQuery("page", "0"))
		if id == "" || len(id) > 2048 || errSnapshot != nil || snapshot == 0 || errPage != nil || page < 0 || page > 1000000 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "valid session_id, snapshot, and page are required"})
			return
		}
		out, err := deps.Service.SessionRequests(c.Request.Context(), id, snapshot, page, c.Query("focus_key"))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}
