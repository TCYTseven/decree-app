package handlers

import "testing"

func TestNew(t *testing.T) {
	if New(struct{ DatabaseURL, APIToken string }{}) == nil {
		t.Fatal("nil")
	}
}
