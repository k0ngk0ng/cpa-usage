package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/k0ngk0ng/cpa-usage/internal/pricing"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// PricingDeps wires pricing handlers to the service layer.
type PricingDeps struct {
	Service *pricing.Service
}

type pricingRequest struct {
	Model                string   `json:"model"`
	PromptPricePer1M     float64  `json:"prompt_price_per_1m"`
	CompletionPricePer1M float64  `json:"completion_price_per_1m"`
	CachePricePer1M      float64  `json:"cache_price_per_1m"`
	CacheWritePricePer1M *float64 `json:"cache_write_price_per_1m"`
}

func listPricingHandler(deps PricingDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		out, err := deps.Service.List(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	}
}

func upsertPricingHandler(deps PricingDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req pricingRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		// /pricing/:model overrides body model when present.
		if param := strings.TrimSpace(c.Param("model")); param != "" {
			req.Model = param
		}
		if err := deps.Service.Upsert(c.Request.Context(), storage.ModelPriceSetting{
			Model:                req.Model,
			PromptPricePer1M:     req.PromptPricePer1M,
			CompletionPricePer1M: req.CompletionPricePer1M,
			CachePricePer1M:      req.CachePricePer1M,
			CacheWritePricePer1M: req.CacheWritePricePer1M,
		}); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func deletePricingHandler(deps PricingDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		model := strings.TrimSpace(c.Query("model"))
		if param := strings.TrimSpace(c.Param("model")); param != "" {
			model = param
		}
		if model == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "model is required"})
			return
		}
		if err := deps.Service.Delete(c.Request.Context(), model); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
