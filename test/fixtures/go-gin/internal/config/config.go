package config

import "os"

type Config struct {
	DatabaseURL string
	APIToken    string
}

func Load() Config {
	return Config{
		DatabaseURL: os.Getenv("DATABASE_URL"),
		APIToken:    os.Getenv("TASKS_API_TOKEN"),
	}
}
