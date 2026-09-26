package main

import (
	"log"
	"os"

	"github.com/acme/tasks-api/internal/config"
	"github.com/acme/tasks-api/internal/handlers"
	"github.com/gin-gonic/gin"
)

func main() {
	cfg := config.Load()
	h := handlers.New(cfg)

	r := gin.Default()
	r.GET("/healthz", h.Health)

	api := r.Group("/api/v1")
	api.Use(h.RequireToken)
	{
		api.GET("/tasks", h.ListTasks)
		api.POST("/tasks", h.CreateTask)
		api.GET("/tasks/:id", h.GetTask)
		api.PUT("/tasks/:id", h.UpdateTask)
		api.DELETE("/tasks/:id", h.DeleteTask)

		admin := api.Group("/admin")
		admin.POST("/purge", h.PurgeCompleted)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Fatal(r.Run(":" + port))
}
