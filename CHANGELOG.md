# Changelog

## 0.4.3

- Show all requests and related sessions in continuous lists without page controls.
- Preserve expanded requests, selected executions, content, and reading position through automatic/manual refresh and late-arriving records; retain the existing list if refresh fails.
- Use compact request rows with time and duration; show dates/models only when they change and move IDs/token totals to hover details. Remove repeated bars and success messages; show failures in red.
- Remove View request links from Events rows; keep session links and request-log access.
- Verify multi-page collection, aborts and incomplete responses, plus long-session refresh and narrow-screen rendering.

## 0.4.2

- Show readable session names on lists, details, and parent/child links; keep UUIDs as secondary identifiers with a Copy ID action.
- Capture titles from associated naming request logs, including Claude structured-title helpers and Responses/Chat Completions JSON or completed SSE responses. Requests must contain naming evidence; ordinary assistant answers are not treated as titles.
- Fall back to a clearly labeled user-message preview for Codex and Claude conversations without an observable naming request. Skip environment/instruction scaffolding, tool results, and hidden content.
- Persist request-log labels in SQLite, prefer newer captured titles over earlier prompt previews, and never inherit child titles into missing parents.
- Discover labels lazily in bounded batches, with concurrency and download limits, missing-log retry cooldowns, and retention cleanup. Full request-log reads also capture label evidence.
- Verify extraction, failure/partial-stream rejection, cache precedence, session isolation, retention, API authentication, remote-log bounds, and desktop/mobile rendering.

## 0.4.1

- Replace Timeline with a session-first **Sessions** page, defaulting to **Today**; preserve old deep links.
- Start from Events or request logs via **View session**, with the source request highlighted and expanded, including requests beyond the first page. Preserve Events filters on return.
- Read chronological request input, response, and tool calls in expandable cards. Collapse earlier context, fetch logs on demand, and expose compact execution timing without a property dump.
- Distinguish final responses from upstream fallback content and show missing/truncated log states explicitly.
- Show referenced-only parents and observed child sessions instead of a misleading not-found page; keep own-session usage totals separate.
- Add snapshot-based request pagination, full-session relationship discovery, and focused-event lookup with existing redaction/authentication.
- Validate parent references, late-arrival snapshots, long-session focus, API authorization, and request/response projection with regression tests.

## 0.4.0

- Add usage timelines grouped by request or session, with responsive waterfalls, zoom, execution details, session navigation, and complete JSON export.
- Preserve CPA trace/execution/session IDs, parent session IDs, fork/compaction markers, streaming state, and response model throughout ingestion, SQLite, APIs, and event details.
- Keep complete retained groups visible when filtering; support exact correlation-ID searches and stable snapshot pagination for large sessions.
- Link event rows and request logs to their timeline. Preserve legacy request-ID grouping and keep anonymous records independent.
- Mark inferred ingest timestamps and explain observed timing, TTFT, additional model accounting, and missing span ancestry without fabricating distributed traces.
- Automatically migrate existing databases and add a request-correlation index; retain content-based event deduplication and existing token accounting.
- Add ingestion, migration, storage, API/authentication, and frontend correlation regression tests; run frontend tests during releases.

CPA does not need to be modified. Historical session/execution metadata that was not previously stored remains unavailable. Timelines represent retained usage records rather than complete HTTP or client tool execution spans.
