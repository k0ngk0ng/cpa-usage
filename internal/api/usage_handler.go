package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"github.com/k0ngk0ng/cpa-usage/internal/usage"
)

// UsageDeps wires the usage handlers to the service layer.
type UsageDeps struct {
	Service *usage.Service
}

func parseFilterFromQuery(c *gin.Context) (usage.Filter, error) {
	rangeKey := c.Query("range")
	startStr := c.Query("start")
	endStr := c.Query("end")
	models := c.QueryArray("model")
	sources := c.QueryArray("source")
	authIndex := c.Query("auth_index")
	result := c.Query("result")
	now := time.Now().In(time.Local)
	return usage.ParseFilter(rangeKey, startStr, endStr, models, sources, authIndex, result, now)
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
