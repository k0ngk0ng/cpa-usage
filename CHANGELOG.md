# Changelog

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
