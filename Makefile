.PHONY: build run tidy test web release-snapshot

VERSION ?= dev
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

LDFLAGS = -s -w -X 'main.Version=$(VERSION)' -X 'main.Commit=$(COMMIT)' -X 'main.BuildDate=$(DATE)'

build:
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o cpa-usage ./cmd/server

run: build
	./cpa-usage

tidy:
	go mod tidy

test:
	go test ./...

web:
	cd web && npm ci && npm run build

release-snapshot: web
	goreleaser release --snapshot --clean --skip=publish
