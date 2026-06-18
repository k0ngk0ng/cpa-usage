#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Fix historical usage_events token semantics for current cpa-usage UI.

Default mode is dry-run:
  scripts/fix_usage_token_history.sh --db /home/cliproxy/cpa-usage/data/app.db

Apply changes:
  scripts/fix_usage_token_history.sh --db /home/cliproxy/cpa-usage/data/app.db --apply --yes

What it changes:
  1. OpenAI/Codex/Gemini/OpenAI-compatible style rows where input_tokens was
     the upstream total prompt/input and cached_tokens was part of it:
       input_tokens      := max(input_tokens - cached_tokens, 0)
       cache_read_tokens := cached_tokens

  2. Claude/Anthropic rows with detailed cache fields where CPA populated
     cached_tokens from cache creation as a fallback:
       cached_tokens := cache_read_tokens

What it does not change:
  - total_tokens is preserved as the upstream/request total.
  - old Claude rows without cache_read_tokens/cache_creation_tokens are left
    unchanged because read vs creation cannot be reconstructed losslessly.
  - unclassified cached rows are left unchanged; inspect the audit output.
EOF
}

DB_PATH=""
APPLY=0
YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      DB_PATH="${2:-}"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --yes|-y)
      YES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$DB_PATH" ]]; then
  DB_PATH="${SQLITE_PATH:-}"
fi
if [[ -z "$DB_PATH" ]]; then
  echo "missing --db or SQLITE_PATH" >&2
  exit 2
fi
if [[ ! -f "$DB_PATH" ]]; then
  echo "database not found: $DB_PATH" >&2
  exit 2
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required" >&2
  exit 2
fi

TABLE_OK="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='usage_events';")"
if [[ "$TABLE_OK" != "1" ]]; then
  echo "usage_events table not found in $DB_PATH" >&2
  exit 2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)_pid$$"
FIX_ID="usage_token_history_fix_${STAMP}"
BACKUP_TABLE="usage_events_token_fix_backup_${STAMP}"

read -r -d '' PREDICATES <<'SQL' || true
WITH classified AS (
  SELECT
    *,
    (
      lower(coalesce(provider, '')) LIKE '%claude%' OR
      lower(coalesce(provider, '')) LIKE '%anthropic%' OR
      lower(coalesce(model, '')) LIKE '%claude%' OR
      lower(coalesce(model, '')) LIKE '%anthropic%' OR
      lower(coalesce(endpoint, '')) LIKE '%anthropic%'
    ) AS is_claude_style,
    (
      lower(coalesce(provider, '')) LIKE '%openai%' OR
      lower(coalesce(provider, '')) LIKE '%codex%' OR
      lower(coalesce(provider, '')) LIKE '%gemini%' OR
      lower(coalesce(provider, '')) LIKE '%vertex%' OR
      lower(coalesce(provider, '')) LIKE '%antigravity%' OR
      lower(coalesce(provider, '')) LIKE '%xai%' OR
      lower(coalesce(provider, '')) LIKE '%kimi%' OR
      lower(coalesce(model, '')) LIKE 'gpt%' OR
      lower(coalesce(model, '')) LIKE 'o1%' OR
      lower(coalesce(model, '')) LIKE 'o3%' OR
      lower(coalesce(model, '')) LIKE 'o4%' OR
      lower(coalesce(model, '')) LIKE '%gemini%' OR
      lower(coalesce(model, '')) LIKE '%codex%' OR
      lower(coalesce(model, '')) LIKE '%grok%' OR
      lower(coalesce(model, '')) LIKE '%kimi%'
    ) AS is_total_input_style
  FROM usage_events
),
targets AS (
  SELECT
    *,
    (
      is_total_input_style = 1 AND
      is_claude_style = 0 AND
      cached_tokens > 0 AND
      cache_read_tokens = 0 AND
      cache_creation_tokens = 0
    ) AS needs_total_style_split,
    (
      is_claude_style = 1 AND
      (cache_read_tokens != 0 OR cache_creation_tokens != 0) AND
      cached_tokens != cache_read_tokens
    ) AS needs_claude_cached_fix
  FROM classified
)
SQL

echo "Database: $DB_PATH"
echo "Mode: $([[ "$APPLY" == "1" ]] && echo apply || echo dry-run)"
echo

sqlite3 -header -column "$DB_PATH" <<SQL
${PREDICATES}
SELECT
  COUNT(*) AS total_rows,
  SUM(CASE WHEN cached_tokens > 0 THEN 1 ELSE 0 END) AS rows_with_cached,
  SUM(CASE WHEN cache_read_tokens != 0 OR cache_creation_tokens != 0 THEN 1 ELSE 0 END) AS rows_with_cache_split,
  SUM(CASE WHEN needs_total_style_split THEN 1 ELSE 0 END) AS rows_to_split_total_style,
  SUM(CASE WHEN needs_claude_cached_fix THEN 1 ELSE 0 END) AS rows_to_fix_claude_cached,
  SUM(CASE
    WHEN cached_tokens > 0
     AND cache_read_tokens = 0
     AND cache_creation_tokens = 0
     AND is_total_input_style = 0
     AND is_claude_style = 0
    THEN 1 ELSE 0
  END) AS ambiguous_cached_rows,
  SUM(CASE
    WHEN cached_tokens > 0
     AND cache_read_tokens = 0
     AND cache_creation_tokens = 0
     AND is_claude_style = 1
    THEN 1 ELSE 0
  END) AS old_claude_uncertain_rows
FROM targets;

${PREDICATES}
SELECT
  provider,
  model,
  COUNT(*) AS rows,
  SUM(input_tokens) AS raw_input,
  SUM(cached_tokens) AS raw_cached,
  SUM(cache_read_tokens) AS raw_cache_read,
  SUM(cache_creation_tokens) AS raw_cache_write,
  SUM(CASE
    WHEN needs_total_style_split AND input_tokens > cached_tokens THEN input_tokens - cached_tokens
    WHEN needs_total_style_split THEN 0
    ELSE input_tokens
  END) AS input_after_fix
FROM targets
WHERE needs_total_style_split OR needs_claude_cached_fix
GROUP BY provider, model
ORDER BY rows DESC
LIMIT 30;
SQL

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry-run only. Re-run with --apply --yes to write changes."
  exit 0
fi

TARGET_COUNT="$(sqlite3 "$DB_PATH" "${PREDICATES}
SELECT COALESCE(SUM(CASE WHEN needs_total_style_split OR needs_claude_cached_fix THEN 1 ELSE 0 END), 0)
FROM targets;")"
if [[ "$TARGET_COUNT" == "0" ]]; then
  echo
  echo "No rows to update."
  exit 0
fi

if [[ "$YES" != "1" ]]; then
  echo
  echo "Refusing to modify without --yes."
  exit 2
fi

sqlite3 "$DB_PATH" <<SQL
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS usage_token_history_fix_runs (
  fix_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  backup_table TEXT NOT NULL,
  old_total_style_rows INTEGER NOT NULL,
  claude_cached_rows INTEGER NOT NULL
);

CREATE TABLE "${BACKUP_TABLE}" AS
${PREDICATES}
SELECT *
FROM targets
WHERE needs_total_style_split OR needs_claude_cached_fix;

INSERT INTO usage_token_history_fix_runs (
  fix_id,
  created_at,
  backup_table,
  old_total_style_rows,
  claude_cached_rows
)
${PREDICATES}
SELECT
  '${FIX_ID}',
  datetime('now'),
  '${BACKUP_TABLE}',
  COALESCE(SUM(CASE WHEN needs_total_style_split THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN needs_claude_cached_fix THEN 1 ELSE 0 END), 0)
FROM targets;

UPDATE usage_events
SET
  input_tokens = CASE
    WHEN input_tokens > cached_tokens THEN input_tokens - cached_tokens
    ELSE 0
  END,
  cache_read_tokens = cached_tokens
WHERE id IN (
  ${PREDICATES}
  SELECT id
  FROM targets
  WHERE needs_total_style_split
);

UPDATE usage_events
SET cached_tokens = cache_read_tokens
WHERE id IN (
  ${PREDICATES}
  SELECT id
  FROM targets
  WHERE needs_claude_cached_fix
);

COMMIT;
PRAGMA foreign_keys = ON;
SQL

echo
echo "Applied fix id: ${FIX_ID}"
echo "Backup table: ${BACKUP_TABLE}"
echo
echo "Restore example:"
echo "sqlite3 '$DB_PATH' \"BEGIN; UPDATE usage_events SET input_tokens=(SELECT b.input_tokens FROM ${BACKUP_TABLE} b WHERE b.id=usage_events.id), cached_tokens=(SELECT b.cached_tokens FROM ${BACKUP_TABLE} b WHERE b.id=usage_events.id), cache_read_tokens=(SELECT b.cache_read_tokens FROM ${BACKUP_TABLE} b WHERE b.id=usage_events.id), cache_creation_tokens=(SELECT b.cache_creation_tokens FROM ${BACKUP_TABLE} b WHERE b.id=usage_events.id), total_tokens=(SELECT b.total_tokens FROM ${BACKUP_TABLE} b WHERE b.id=usage_events.id) WHERE id IN (SELECT id FROM ${BACKUP_TABLE}); COMMIT;\""
