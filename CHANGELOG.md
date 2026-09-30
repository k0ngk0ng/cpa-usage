# Changelog

## 0.4.0

- Add usage timelines grouped by request or session, with responsive waterfalls, zoom, execution details, session navigation, and complete JSON export.
- Preserve CPA trace/execution/session IDs, parent session IDs, fork/compaction markers, streaming state, and response model throughout ingestion, SQLite, APIs, and event details.
- Keep complete retained groups visible when filtering; support exact correlation-ID searches and stable snapshot pagination for large sessions.
- Link event rows and request logs to their timeline. Preserve legacy request-ID grouping and keep anonymous records independent.
- Mark inferred ingest timestamps and explain observed timing, TTFT, additional model accounting, and missing span ancestry without fabricating distributed traces.
- Automatically migrate existing databases and add a request-correlation index; retain content-based event deduplication and existing token accounting.
- Add ingestion, migration, storage, API/authentication, and frontend correlation regression tests; run frontend tests during releases.

CPA does not need to be modified. Historical session/execution metadata that was not previously stored remains unavailable. Timelines represent retained usage records rather than complete HTTP or client tool execution spans.
