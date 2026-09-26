BINARY := tasks-api
IMAGE ?= ghcr.io/acme/tasks-api

.PHONY: build test run lint deploy docker-build

build:
	go build -o bin/tasks-api .

test:
	go test ./...

run: build
	./bin/tasks-api

lint:
	@golangci-lint run ./...

docker-build:
	docker build -t $(IMAGE) .

deploy: docker-build
	docker push $(IMAGE)
	fly deploy --image $(IMAGE)
