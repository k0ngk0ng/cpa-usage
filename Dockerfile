# syntax=docker/dockerfile:1.6

# ---------- Stage 1: build the SPA ----------
FROM node:20-alpine AS web-builder
WORKDIR /src/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# ---------- Stage 2: build the Go binary (with dist embedded) ----------
FROM golang:1.26-alpine AS go-builder
WORKDIR /src

RUN apk add --no-cache git ca-certificates tzdata

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
# Bring the freshly built SPA into the embed path before `go build`.
COPY --from=web-builder /src/web/dist ./web/dist

ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown

ENV CGO_ENABLED=0 GOOS=linux

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build \
        -ldflags "-s -w -X 'main.Version=${VERSION}' -X 'main.Commit=${COMMIT}' -X 'main.BuildDate=${BUILD_DATE}'" \
        -o /out/cpa-usage \
        ./cmd/server

# ---------- Stage 3: minimal runtime ----------
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata wget && \
    addgroup -S app && adduser -S -G app -H -h /var/lib/cpa-usage app && \
    mkdir -p /var/lib/cpa-usage/data /var/lib/cpa-usage/logs /home/cliproxy/logs && \
    chown -R app:app /var/lib/cpa-usage

COPY --from=go-builder /out/cpa-usage /usr/local/bin/cpa-usage

# Binary defaults are relative (./data/app.db, ./logs); WORKDIR below anchors
# them under the data volume. Only override what differs from the binary
# defaults.
ENV APP_PORT=8318 \
    CPA_LOG_DIR=/home/cliproxy/logs \
    TZ=Asia/Shanghai

EXPOSE 8318

VOLUME ["/var/lib/cpa-usage"]

USER app
WORKDIR /var/lib/cpa-usage

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${APP_PORT}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/cpa-usage"]
