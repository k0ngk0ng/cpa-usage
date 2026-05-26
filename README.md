# cpa-usage

Persistent usage analytics for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) v6.10+.

CPA v6.10 removed the legacy `/v0/management/usage/{export,import}` HTTP endpoints; usage records now flow through a Redis-style RESP queue multiplexed onto the same TCP port (default `8317`). `cpa-usage` drains that queue, persists records to SQLite, and ships a single static binary that exposes a dashboard and API on a configurable subpath (default `/usage`).

## What it does

- Drains CPA's Redis usage queue (LPOP loop) and persists records as deduplicated `usage_events` rows
- Periodically refreshes auth-files and provider catalogs from CPA management API
- Computes per-model cost from configurable price-per-1M-token settings
- Serves an API + SPA at `/usage/*` (subpath configurable)
- Optional cookie-based password login
- Daily 03:00 retention sweep (drops events older than 30 days, then `VACUUM`)

## Quick start (development)

```bash
cd github.com/k0ngk0ng/cpa-usage
go mod tidy

# Build the SPA bundle once — the Go binary embeds web/dist/, but the
# directory is .gitignored. Releases run this automatically via goreleaser;
# locally you need to do it yourself before `go build`.
(cd web && npm ci && npm run build)

go build ./cmd/server

CPA_BASE_URL=http://127.0.0.1:8317 \
CPA_MANAGEMENT_KEY=your-mgmt-key \
SQLITE_PATH=/tmp/cpa-usage.db \
APP_BASE_PATH=/usage \
LOG_FILE_ENABLED=false \
./server

# In another shell:
curl http://127.0.0.1:8318/healthz
curl 'http://127.0.0.1:8318/usage/api/v1/usage/overview?range=24h' | jq
```

## Production install (Linux, systemd)

GitHub Releases ship a `cpa-usage_<version>_linux_<arch>.tar.gz` archive (`amd64` and `aarch64`). The accompanying installer reuses the `cliproxy` system user that the CPA installer creates (so cpa-usage and CPA share state under `/home/cliproxy`), drops the binary under `/home/cliproxy/cpa-usage/releases/<ver>`, and writes a systemd unit:

```bash
sudo ./cpa-usage-install.sh --version 0.0.1-0
```

After install, edit `/home/cliproxy/cpa-usage/.env` to populate `CPA_BASE_URL` and `CPA_MANAGEMENT_KEY`, then:

```bash
sudo systemctl restart cpa-usage
journalctl -u cpa-usage -f
curl http://127.0.0.1:8318/usage/healthz
```

## Configuration

All configuration is via environment variables (also see `.env.example`):

| Var | Default | Notes |
|---|---|---|
| `CPA_BASE_URL` | — | Required |
| `CPA_MANAGEMENT_KEY` | — | Required |
| `APP_PORT` | `8318` | |
| `APP_BASE_PATH` | `/usage` | Set to `""` for root mount |
| `TZ` | `Asia/Shanghai` | Drives "today" boundary + 03:00 cleanup |
| `STORAGE_DRIVER` | `sqlite` | Only `sqlite` in v1 |
| `SQLITE_PATH` | `./data/app.db` | Resolved against the process working directory |
| `REDIS_QUEUE_ADDR` | — | Defaults to `<cpa-host>:8317` |
| `REDIS_QUEUE_BATCH_SIZE` | `1000` | |
| `REDIS_QUEUE_IDLE_INTERVAL` | `1s` | |
| `REDIS_QUEUE_ERROR_BACKOFF` | `10s` | |
| `METADATA_SYNC_INTERVAL` | `30s` | |
| `AUTH_ENABLED` | `false` | When true, `LOGIN_PASSWORD` is required |
| `LOGIN_PASSWORD` | — | Required if `AUTH_ENABLED=true` |
| `AUTH_SESSION_TTL` | `168h` | |
| `LOG_LEVEL` | `info` | |
| `LOG_FILE_ENABLED` | `true` | |
| `LOG_DIR` | `./logs` | Resolved against the process working directory |
| `LOG_RETENTION_DAYS` | `7` | Lumberjack max-age + max-backups |

## API surface

All endpoints are mounted under `<APP_BASE_PATH>/api/v1`. Protected endpoints require a valid session cookie when `AUTH_ENABLED=true`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | liveness + version |
| GET | `/auth/session` | session status |
| POST | `/auth/login` | `{ "password": "..." }` |
| POST | `/auth/logout` | clear cookie |
| GET | `/status` | drain status (last pop, errors, totals) |
| POST | `/sync` | trigger metadata refresh |
| GET | `/usage/overview` | summary + hourly + daily + range-sized 15-minute health grid |
| GET | `/usage/health` | year request matrix + optional selected-day 5-minute detail |
| GET | `/usage/analysis` | aggregations by API / model / both |
| GET | `/usage/events` | paginated raw events |
| GET | `/usage/events/filters` | distinct models + sources |
| GET | `/usage/credentials` | per-source success/failure rollup |
| GET | `/auth-files` | cached CPA auth-files |
| GET | `/provider-metadata` | cached provider catalog |
| GET | `/models/used` | union of CPA `/v1/models` and DB-observed models |
| GET | `/pricing` | list per-model price settings |
| PUT | `/pricing` or `/pricing/:model` | upsert |
| DELETE | `/pricing` or `/pricing/:model` | remove |
| GET | `/aliases` | list api_keys observed in events with their alias |
| PUT | `/aliases` | upsert `{ "api_key": "...", "alias": "..." }` |
| DELETE | `/aliases?api_key=...` | clear alias |
| GET | `/aliases/export` | JSON dump of all aliases |
| POST | `/aliases/import` | bulk merge / replace |

Common query params: `range=all|today|4h|8h|12h|24h|2d|3d|7d|30d|custom`, `start`, `end`, `model` (repeatable), `source` (repeatable), `auth_index`, `result=success|failed`, `page`, `page_size`.

## Architecture

```
CPA (Redis queue on tcp/8317)
        │
        ▼
internal/cpa/redis_queue ──► internal/ingest/decoder ──► storage.Store.InsertUsageEvents
                                                              │
                                                              ▼
                                                       SQLite (gorm + glebarez)
                                                              │
internal/cpa/client ──► internal/metadata.Service             │
                              │                                ▼
                              ▼                          API handlers
                  storage.Store.ReplaceAuthFiles               │
                  storage.Store.ReplaceProviderMetadata        ▼
                                                          embedded SPA
```

`storage.Store` is the only seam between the service layer and the database; v1 ships a single `internal/storage/sqlite` implementation, but new drivers (mysql, postgres, clickhouse) can plug in by satisfying the interface.

## Layout

```
cmd/server/             entrypoint (ldflag-injected version)
internal/
  api/                  gin router + handlers + embedded SPA
  app/                  composition root + maintenance loop
  auth/                 in-memory session manager
  config/               env loader
  cpa/                  CPA HTTP client + RESP redis client
  drain/                pop/decode/insert + metadata orchestration
  ingest/               JSON record → storage.UsageEvent
  logging/              logrus + lumberjack rotation
  metadata/             auth-files + provider catalog refresher
  pricing/              price catalog cache
  redact/               api_key alias + display masking
  storage/              Store interface + types
    sqlite/             gorm + glebarez/sqlite implementation
  usage/                filter parsing, decoration, service entrypoint
web/                    embedded SPA bundle
.github/workflows/      goreleaser pipeline
```

## License

MIT — see `LICENSE`.
