package models

import "gorm.io/gorm"

type Task struct {
	gorm.Model
	Title string `json:"title" gorm:"not null"`
	Done  bool   `json:"done"`
}
