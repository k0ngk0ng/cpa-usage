# cpa-usage

Persistent usage analytics for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) v6.10+.

CPA v6.10 removed the legacy `/v0/management/usage/{export,import}` HTTP endpoints; usage records now flow through a Redis-style RESP queue multiplexed onto the same TCP port (default `8317`). `cpa-usage` drains that queue, persists records to SQLite, and ships a single static binary that exposes a dashboard and API on a configurable subpath (default `/usage`).

## What it does

- Subscribes to CPA's Redis usage stream, drains pre-subscription LPOP backlog, and persists every distinct provider-call record
- Consumes CPA token accounting v2 when available, preserving uncached/cache-read/cache-write, total/non-reasoning/reasoning, quality, and unclassified buckets without provider-specific double counting
- Periodically refreshes auth-files and provider catalogs from CPA management API
- Reads per-request logs from `CPA_LOG_DIR`, falling back to CPA's authenticated `request-log-by-id` management endpoint when the filesystem is not shared
- Reads sessions as chronological request/response conversations, with tool calls, execution timing, parent/child navigation, and usage JSON export
- Computes per-model cost from configurable input, output, cache-read, and cache-write price-per-1M-token settings
- Serves an API + SPA at `/usage/*` (subpath configurable)
- Optional JWT cookie-based password login
- Retains usage events indefinitely by default; optional daily 03:00 retention cleanup is configurable

## Sessions (0.4.2)

Start in **Events** and choose **View session** on a row or in its request-log dialog. The session opens with that request located, highlighted and expanded in one continuous list. Read requests oldest first: each expandable row shows **Request input**, **Response**, and tool calls/results. Earlier supplied conversation context is collapsed so repeated history does not overwhelm the page; it remains available in full. **Execution timeline** reveals compact observed usage bars. **Open request log** opens complete properties and raw content. The request-log dialog also offers **View request**, including records without a session ID; event rows only show the session link.

Sessions display **Captured title** when an associated request log contains a recognizable naming instruction and its final generated title. Claude Code's structured-title helpers and OpenAI Responses/Chat Completions JSON or completed SSE formats are supported. Otherwise, **Prompt preview** shows an excerpt from the earliest readable retained user input, excluding instruction/environment scaffolding and tool results. UUIDs remain below the name and can be copied in the detail view. Titles also appear on parent/child links.

CPA usage does not contain client titles. A Codex or Claude title generated outside CPA, a client-side rename, or a naming request without a retained session association cannot be recovered. Previews are not presented as client-generated titles, and no additional model call is made. A referenced-only parent never inherits a child's title.

Names are discovered separately from usage loading and cached in SQLite. Previously captured names load immediately from the cache before further log discovery (`cached=1` on the label endpoint). Each lookup reads at most eight logs (prioritizing early context and recent naming calls), with two concurrent lookups and a 12-second budget. Background discovery skips logs over 8 MiB and limits parsed bodies to 2 MiB; opening the full request log can capture evidence from larger logs. The UI checks up to three batches per visit; Refresh resumes discovery. Unavailable logs retry after five minutes. Captured names remain cached while their associated usage is retained; configured usage cleanup removes orphaned labels. The newest captured naming response takes precedence over previews.

The **Sessions** page lists sessions only, with **Today** as the default range. Filter by time, model, credential, API key, result, or an exact session/parent-session/trace/request/execution ID. Filters select sessions with matching activity; opening a session includes its full retained history. All requests load into one chronological list without page controls. Compact rows show time and duration, with dates and models shown only when they change; IDs and token totals are available on hover. Only failures display status text. Automatic and manual refresh preserve expanded requests and reading position, including when late records arrive earlier in the session. Events return links preserve the original filters. Old `/timeline` links redirect to `/sessions` with their parameters preserved.

Input/output is loaded lazily from the existing request-log API. JSON and SSE responses use the same structured chat renderer as request logs. Several executions can share one inbound request log; its final response is not an independently mapped response for each execution. If no client response was retained, the last logged upstream response is clearly labeled. Missing, unreadable, and truncated logs are shown explicitly; usage remains visible.

**Related sessions** lists parents and observed children separately. A parent referenced by retained records but with no own usage opens as **Referenced session · no own retained usage**, with its observed children. Its own usage is not fabricated and child totals are not added to its totals. Older session IDs cannot be reconstructed from records that never stored them.

**Export usage JSON** downloads the entire selected usage snapshot, including pages not displayed. Execution details paginate 200 usage records at a time with a fixed insertion-ID upper bound. Refresh opens a new snapshot. Retention cleanup can still remove records from an open snapshot.

### 从 Events 开始追踪会话

1. 在 **Events** 找到请求，点击行内或请求日志弹窗里的 **View session**。
2. 当前请求会在会话列表中高亮并展开；按时间依次展开其他请求，阅读输入、响应和工具调用。**Earlier context** 可展开请求携带的完整历史上下文。
3. **Execution timeline** 查看该请求内的执行耗时；**Open request log** 查看完整属性和原始日志。
4. **Related sessions** 继续查看父会话、子会话；**← Events** 返回原来的筛选结果。

列表、详情和父子会话链接优先显示 **Captured title**；无法捕获自动名称时显示 **Prompt preview**，UUID 作为辅助信息保留。Codex/Claude 在 CPA 之外生成或手动修改的名称无法直接同步。

Sessions 默认 **Today**。没有 session ID 的旧记录仍可从 request-log 对话框的 **View request** 查看。只有父会话引用时会解释自身记录缺失并列出子会话；请求/响应正文依赖仍可读取的 CPA request log。

Timing is deliberately limited to what usage reports: bars run from `timestamp` to `timestamp + max(0, latency_ms)`. The group envelope is observed usage time, not total HTTP duration. Overlap does not prove parallel execution; multiple records can be retries or additional-model accounting. TTFT is displayed as a reported duration, never positioned on the timestamp axis, because it may use a different start or fall back to first-packet timing. Records ingested without a timestamp are labeled as inferred ingest time. Client-side tools, real parent spans, and requests without usage are not synthesized.

Upgrades automatically add nullable metadata columns and correlation indexes to SQLite. Existing events retain their IDs and accounting; the content-derived `event_key` remains the deduplication key. `request_id`, `trace_id`, and `execution_id` are **not** unique database keys. CPA remains unchanged, and all new fields are optional for compatibility with older versions. Already-consumed metadata cannot be recovered from the existing database.

Timeline API examples (under `<APP_BASE_PATH>/api/v1`):

```text
GET /usage/timelines?mode=session&range=today&result=failed
GET /usage/timelines?mode=session&range=all&parent_session_id=<id>
GET /usage/timelines/detail?key=request%3A<id>&focus_event=<event-key>
GET /usage/timelines/detail?key=session%3A<id>&cursor=<next_cursor>&snapshot=<snapshot>
GET /usage/timelines/session-requests?session_id=<id>&snapshot=<snapshot>&page=0&focus_key=request%3A<id>
```

List responses use `items`, `total`, `page`, and `page_size` (20 groups). Detail responses use `summary`, `items`, `snapshot`, and `next_cursor` (zero means the final page). Omit cursor/snapshot for the initial request. Keys are namespaced as `request:<trace-or-request-id>`, `session:<session-id>`, or `event:<event-key>` and must be URL-encoded. `trace_id` searches include legacy request-ID fallback; `request_id` searches match the log request ID exactly. The existing events endpoint also accepts exact `trace_id`, `execution_id`, `session_id`, and `parent_session_id` filters. Detail also returns `referenced_only`, `sessions`, `parent_sessions`, `child_sessions`, `referencing_records`, and optional `focused_event`. Session-request pagination uses `page=0` to locate the page containing `focus_key` (or page 1 when absent); positive pages are explicit. All timeline APIs use the same authentication and display-name redaction as usage events.

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
sudo ./cpa-usage-install.sh --version 0.4.2
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
| `CPA_LOG_DIR` | `/home/cliproxy/logs` | Preferred local request-log directory; missing files fall back to CPA's management API |
| `APP_PORT` | `8318` | |
| `APP_BASE_PATH` | `/usage` | Set to `""` for root mount |
| `TZ` | `Asia/Shanghai` | Drives "today" boundary + optional 03:00 cleanup |
| `STORAGE_DRIVER` | `sqlite` | Only `sqlite` in v1 |
| `SQLITE_PATH` | `./data/app.db` | Resolved against the process working directory |
| `USAGE_RETENTION_DAYS` | `0` | Usage row retention; `0` keeps data indefinitely, positive values enable startup + daily 03:00 cleanup |
| `REDIS_QUEUE_ADDR` | — | Defaults to `<cpa-host>:8317` |
| `REDIS_QUEUE_KEY` | `usage` | RESP channel name; CPA v7+ rejects the old `queue` key |
| `REDIS_QUEUE_BATCH_SIZE` | `1000` | Subscription persistence batch size and LPOP backlog batch size |
| `REDIS_QUEUE_IDLE_INTERVAL` | `1s` | |
| `REDIS_QUEUE_ERROR_BACKOFF` | `10s` | |
| `METADATA_SYNC_INTERVAL` | `30s` | |
| `AUTH_ENABLED` | `false` | When true, `LOGIN_PASSWORD` is required |
| `LOGIN_PASSWORD` | — | Required if `AUTH_ENABLED=true` |
| `AUTH_SESSION_TTL` | `168h` | JWT cookie lifetime |
| `LOG_LEVEL` | `info` | |
| `LOG_FILE_ENABLED` | `true` | |
| `LOG_DIR` | `./logs` | Resolved against the process working directory |
| `LOG_RETENTION_DAYS` | `7` | Lumberjack max-age + max-backups |

On the Pricing page, Cache Write is independently configurable. Leaving it
blank uses the model's Input price, which preserves sensible costing for older
price rows while still allowing an explicit zero or provider-specific write rate.

CPA v7.2.97+ emits canonical token accounting v2. Older queue rows remain
supported through executor/provider-aware compatibility rules; model names are
never used to infer token semantics. CPA v7.2.104+ also attaches downstream
`client_ip`, `x_forwarded_for`, and `user_agent` values, and v7.2.111+ attaches
an OAuth `access_token_sha256` fingerprint. These observability fields are
stored with the event, so enable `AUTH_ENABLED` when the dashboard is reachable
outside a trusted network.

## API surface

All endpoints are mounted under `<APP_BASE_PATH>/api/v1`. Protected endpoints require a valid JWT auth cookie when `AUTH_ENABLED=true`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | liveness + version |
| GET | `/auth/session` | auth status |
| POST | `/auth/login` | `{ "password": "..." }` |
| POST | `/auth/logout` | clear cookie |
| GET | `/status` | drain status (last pop, errors, totals) |
| POST | `/sync` | trigger metadata refresh |
| GET | `/usage/overview` | summary + hourly + daily + range-sized 15-minute health grid |
| GET | `/usage/health` | year request matrix + optional selected-day 5-minute detail |
| GET | `/usage/analysis` | aggregations by API / model / both |
| GET | `/usage/sessions/label?session_id=<id>` | cached title/preview and bounded request-log discovery (`title`, `source`, `request_id`, `more`) |
| GET | `/usage/timelines` | paginated request/session groups; matching filters select complete retained groups |
| GET | `/usage/timelines/detail` | observed envelope, session relationships, and cursor-paginated records for one group |
| GET | `/usage/timelines/session-requests` | chronological request groups within a session snapshot; optional source-request focus |
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

Common query params: `range=all|today|4h|8h|12h|24h|2d|3d|4d|5d|6d|7d|30d|custom`, `start`, `end`, `model` (repeatable), `source` (repeatable), `auth_index`, `result=success|failed`, `page`, `page_size`.

## Architecture

```
CPA (Redis SUBSCRIBE + LPOP backlog on tcp/8317)
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

CPA emits one usage record per upstream provider call. Retries and auxiliary
models such as Codex image generation may therefore share a `request_id`.
`cpa-usage` keeps `request_id` as a searchable, non-unique correlation ID and
deduplicates exact queue records with a content-derived `event_key`.

## Layout

```
cmd/server/             entrypoint (ldflag-injected version)
internal/
  api/                  gin router + handlers + embedded SPA
  app/                  composition root + maintenance loop
  auth/                 password auth + JWT token manager
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
  tokenusage/           canonical/legacy token accounting compatibility
  usage/                filter parsing, decoration, service entrypoint
web/                    embedded SPA bundle
.github/workflows/      goreleaser pipeline
```

## License

MIT — see `LICENSE`.
