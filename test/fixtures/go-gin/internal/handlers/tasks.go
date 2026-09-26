package handlers

import (
	"net/http"

	"github.com/acme/tasks-api/internal/config"
	"github.com/acme/tasks-api/internal/models"
	"github.com/gin-gonic/gin"
)

type Handlers struct{ cfg config.Config }

func New(cfg config.Config) *Handlers { return &Handlers{cfg: cfg} }

type createTaskRequest struct {
	Title string `json:"title" binding:"required"`
}

func (h *Handlers) Health(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) }

func (h *Handlers) RequireToken(c *gin.Context) {
	if c.GetHeader("Authorization") != "Bearer "+h.cfg.APIToken {
		c.AbortWithStatus(http.StatusUnauthorized)
	}
}

func (h *Handlers) ListTasks(c *gin.Context) { c.JSON(http.StatusOK, []models.Task{}) }

func (h *Handlers) CreateTask(c *gin.Context) {
	var req createTaskRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, models.Task{Title: req.Title})
}

func (h *Handlers) GetTask(c *gin.Context)       { c.JSON(http.StatusOK, gin.H{"id": c.Param("id")}) }
func (h *Handlers) UpdateTask(c *gin.Context)    { c.JSON(http.StatusOK, gin.H{"id": c.Param("id")}) }
func (h *Handlers) DeleteTask(c *gin.Context)    { c.Status(http.StatusNoContent) }
func (h *Handlers) PurgeCompleted(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"purged": 0}) }
