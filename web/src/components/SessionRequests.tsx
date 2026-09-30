import SessionName from "./SessionName";
import RequestConversation from "./RequestConversation";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { api } from "../api/client";
import type { TimelineDetail, TimelinePage } from "../api/types";
import { defaultFilter } from "../hooks/useFilter";
import { formatLatency, formatNumber, formatTimestamp } from "../lib/utils";
import { barPosition, shortID } from "../lib/timeline";

const button =
  "rounded border border-border bg-panel2 px-3 py-1.5 text-xs hover:text-ink disabled:opacity-40";

export function SessionRequests({
  detail,
  originRequest,
  focusEvent,
  onOpen,
}: {
  detail: TimelineDetail;
  originRequest: string;
  focusEvent: string;
  onOpen: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(originRequest ? [originRequest] : []),
  );
  const selectedRequest = useRef<HTMLElement | null>(null);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<TimelinePage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const sessionID = detail.summary.key.slice(8);
  useEffect(() => {
    setPage(0);
    setExpanded(new Set(originRequest ? [originRequest] : []));
  }, [originRequest]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api
      .sessionRequests(
        sessionID,
        detail.snapshot,
        page,
        originRequest,
        controller.signal,
      )
      .then((next) => {
        if (!controller.signal.aborted) setData(next);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sessionID, detail.snapshot, page, originRequest]);
  useEffect(() => {
    if (
      !loading &&
      data?.items.some((request) => request.key === originRequest)
    )
      selectedRequest.current?.scrollIntoView({ block: "nearest" });
  }, [data, loading, originRequest]);
  const duration = Math.max(
    1,
    detail.summary.ended_at_ms - detail.summary.started_at_ms,
  );
  return (
    <section
      className="space-y-3 border-t border-border p-4"
      aria-label="Requests in this session"
      aria-busy={loading}
    >
      <h3 className="text-base font-semibold">
        Requests in this session{" "}
        <span className="ml-2 text-muted">
          {formatNumber(detail.summary.request_count)}
        </span>
      </h3>
      <p className="text-xs leading-relaxed text-muted">
        Read requests oldest first. Expand each request to read its input,
        response and tool calls. Bars locate requests within the session;
        related sessions have their own request lists.
      </p>
      {originRequest &&
        data?.items.some((request) => request.key === originRequest) && (
          <p className="text-xs text-accent">
            The request you opened is highlighted. The list starts on its page
            when it belongs to this session.
          </p>
        )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {loading && !data && (
        <p className="py-4 text-sm text-muted" role="status">
          Loading session requests…
        </p>
      )}
      {data && !error && (
        <>
          <div className="grid gap-2">
            {data.items.map((request, index) => (
              <article
                ref={
                  request.key === originRequest ? selectedRequest : undefined
                }
                key={request.key}
                className={clsx(
                  "min-w-0 overflow-hidden rounded-lg border",
                  request.key === originRequest
                    ? "border-accent"
                    : "border-border",
                )}
              >
                <button
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(request.key)) next.delete(request.key);
                      else next.add(request.key);
                      return next;
                    })
                  }
                  disabled={loading}
                  aria-expanded={expanded.has(request.key)}
                  aria-label={`Read request ${request.key.slice(request.key.indexOf(":") + 1)}`}
                  className={clsx(
                    "w-full",
                    "min-w-0 p-3 text-left hover:bg-panel2 disabled:opacity-50",
                    request.key === originRequest
                      ? "border-accent bg-accent/5"
                      : "border-border bg-bg",
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-muted">
                      #{(data.page - 1) * data.page_size + index + 1} ·{" "}
                      {formatTimestamp(
                        new Date(request.started_at_ms).toISOString(),
                      )}
                    </span>
                    <span
                      className={
                        request.failed ? "text-danger" : "text-success"
                      }
                    >
                      {request.failed
                        ? `${request.failed} / ${request.records} usage records failed`
                        : "No failures reported"}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <strong className="text-sm">
                      {request.model || "Unknown model"}
                      {request.model_count > 1 &&
                        ` +${request.model_count - 1} models`}
                    </strong>
                    <span
                      className="min-w-0 truncate font-mono text-xs text-muted"
                      title={request.key}
                    >
                      {shortID(request.key.slice(request.key.indexOf(":") + 1))}
                    </span>
                    {request.key === originRequest && (
                      <span className="text-[10px] text-accent">
                        Selected request
                      </span>
                    )}
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded bg-panel2">
                    <div className="relative h-full">
                      <div
                        className={clsx(
                          "absolute h-full rounded",
                          request.failed ? "bg-warn" : "bg-accent",
                        )}
                        style={barPosition(
                          request.started_at_ms,
                          request.ended_at_ms,
                          detail.summary.started_at_ms,
                          duration,
                        )}
                      />
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-muted">
                      {formatLatency(
                        request.ended_at_ms - request.started_at_ms,
                      )}{" "}
                      observed · {request.records} usage{" "}
                      {request.records === 1 ? "record" : "records"} ·{" "}
                      {formatNumber(request.total_tokens)} tokens
                    </span>
                    <span className="text-accent">
                      {expanded.has(request.key)
                        ? "Collapse request ↑"
                        : "Read input & response ↓"}
                    </span>
                  </div>
                </button>
                {expanded.has(request.key) && (
                  <>
                    <RequestConversation
                      requestKey={request.key}
                      snapshot={detail.snapshot}
                      focusEvent={
                        request.key === originRequest ? focusEvent : ""
                      }
                    />
                    <button
                      className="mx-4 mb-3 text-xs text-accent"
                      onClick={() => onOpen(request.key)}
                    >
                      Open request separately →
                    </button>
                  </>
                )}
              </article>
            ))}
          </div>
          {data.total === 0 && (
            <p className="text-sm text-muted">
              No request records remain in this session snapshot. Refresh the
              session to update it.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <button
              className={button}
              disabled={loading || data.page <= 1}
              onClick={() => setPage(data.page - 1)}
            >
              Previous requests
            </button>
            <span>
              {data.total
                ? `${(data.page - 1) * data.page_size + 1}–${Math.min(data.page * data.page_size, data.total)}`
                : "0"}{" "}
              of {formatNumber(data.total)} requests
            </span>
            <button
              className={button}
              disabled={loading || data.page * data.page_size >= data.total}
              onClick={() => setPage(data.page + 1)}
            >
              Next requests
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function RelatedSessions({
  detail,
  onOpen,
}: {
  detail: TimelineDetail;
  onOpen: (key: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TimelinePage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const id = detail.summary.key.slice(8);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError("");
    api
      .timelines(
        { ...defaultFilter, range: "all" },
        "session",
        page,
        { parent_session_id: id },
        c.signal,
      )
      .then((next) => {
        if (!c.signal.aborted) setData(next);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [id, page, detail.snapshot]);
  return (
    <section
      className="space-y-3 border-t border-border p-4"
      aria-label="Related sessions"
    >
      <h3 className="text-sm font-semibold">Related sessions</h3>
      {detail.parent_sessions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted">Reported parent sessions</p>
          {detail.parent_sessions
            .filter((parent) => parent.id !== id)
            .map((parent) => (
              <button
                key={parent.id}
                onClick={() => onOpen(`session:${parent.id}`)}
                className={clsx(
                  button,
                  "flex w-full flex-wrap items-center justify-between gap-2 text-left",
                )}
              >
                <SessionName id={parent.id} />
                <span className="text-accent">
                  {parent.has_records
                    ? "View parent session →"
                    : "Parent referenced · no own usage →"}
                </span>
              </button>
            ))}
        </div>
      )}
      <p className="text-xs text-muted">
        Child sessions contain their own requests. Their usage is kept separate
        from this session’s totals.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {loading && !data && (
        <p className="text-xs text-muted">Loading related sessions…</p>
      )}
      {data && !error && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.items.map((child) => (
              <button
                disabled={loading}
                key={child.key}
                onClick={() => onOpen(child.key)}
                className="min-w-0 rounded border border-border bg-bg p-3 text-left hover:bg-panel2 disabled:opacity-50"
              >
                <SessionName id={child.key.slice(8)} />
                <div className="mt-2 text-xs text-muted">
                  {child.request_count}{" "}
                  {child.request_count === 1 ? "request" : "requests"} ·{" "}
                  {formatNumber(child.total_tokens)} tokens
                  {child.failed > 0 && (
                    <span className="text-danger">
                      {" "}
                      · {child.failed} failed records
                    </span>
                  )}
                </div>
                <div className="mt-2 text-xs text-accent">
                  View child session requests →
                </div>
              </button>
            ))}
          </div>
          {data.total === 0 && (
            <p className="text-xs text-muted">
              No child sessions are present in retained usage.
            </p>
          )}
          {data.total > data.page_size && (
            <div className="flex items-center justify-between text-xs">
              <button
                className={button}
                disabled={loading || page === 1}
                onClick={() => setPage(page - 1)}
              >
                Previous sessions
              </button>
              <span className="text-muted">
                Page {page} / {Math.ceil(data.total / data.page_size)}
              </span>
              <button
                className={button}
                disabled={loading || page * data.page_size >= data.total}
                onClick={() => setPage(page + 1)}
              >
                Next sessions
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
