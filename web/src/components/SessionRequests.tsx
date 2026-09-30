import SessionName from "./SessionName";
import RequestConversation from "./RequestConversation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  collectSessionPages,
  captureRequestPosition,
} from "../lib/sessionRequests";
import { api } from "../api/client";
import type { TimelineDetail, TimelinePage } from "../api/types";
import { defaultFilter } from "../hooks/useFilter";
import { formatLatency, formatNumber, formatTimestamp } from "../lib/utils";

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
  const root = useRef<HTMLElement | null>(null);
  const restorePosition = useRef<(() => void) | null>(null);
  const locatedRequest = useRef("");
  const [data, setData] = useState<TimelinePage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const sessionID = detail.summary.key.slice(8);
  useEffect(() => {
    if (originRequest)
      setExpanded((current) => new Set([...current, originRequest]));
  }, [originRequest]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    collectSessionPages(
      (page) =>
        api.sessionRequests(
          sessionID,
          detail.snapshot,
          page,
          "",
          controller.signal,
        ),
      controller.signal,
    )
      .then((next) => {
        if (!controller.signal.aborted) {
          restorePosition.current = captureRequestPosition(root.current);
          setData(next);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sessionID, detail]);
  useLayoutEffect(() => {
    restorePosition.current?.();
    restorePosition.current = null;
  }, [data]);
  useEffect(() => {
    if (
      originRequest !== locatedRequest.current &&
      data?.items.some((request) => request.key === originRequest)
    ) {
      locatedRequest.current = originRequest;
      selectedRequest.current?.scrollIntoView({ block: "nearest" });
    }
  }, [data, originRequest]);
  return (
    <section
      ref={root}
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
        Oldest first · Select a request to read its input, response and tool
        calls.
      </p>
      {originRequest &&
        data?.items.some((request) => request.key === originRequest) && (
          <p className="text-xs text-accent">
            The request you opened is highlighted in the conversation.
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
      {data && (
        <>
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {data.items.map((request, index) => (
              <article
                ref={
                  request.key === originRequest ? selectedRequest : undefined
                }
                key={request.key}
                data-request-key={request.key}
                className={clsx(
                  "min-w-0 overflow-hidden",
                  request.key === originRequest ? "bg-accent/5" : "bg-bg",
                )}
              >
                {(index === 0 ||
                  formatTimestamp(
                    new Date(request.started_at_ms).toISOString(),
                  ).slice(0, 10) !==
                    formatTimestamp(
                      new Date(
                        data.items[index - 1].started_at_ms,
                      ).toISOString(),
                    ).slice(0, 10)) && (
                  <div className="bg-panel2 px-3 py-1 text-[11px] text-muted">
                    {formatTimestamp(
                      new Date(request.started_at_ms).toISOString(),
                    ).slice(0, 10)}
                  </div>
                )}
                <button
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(request.key)) next.delete(request.key);
                      else next.add(request.key);
                      return next;
                    })
                  }
                  aria-expanded={expanded.has(request.key)}
                  aria-label={`Read request ${request.key.slice(request.key.indexOf(":") + 1)}`}
                  title={`${request.key.slice(request.key.indexOf(":") + 1)} · ${request.model || "Unknown model"} · ${formatNumber(request.total_tokens)} tokens`}
                  className={clsx(
                    "flex min-h-9 w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs hover:bg-panel2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                    request.key === originRequest && "border-l-2 border-accent",
                  )}
                >
                  <span className="w-8 shrink-0 text-muted tabular-nums">
                    #{index + 1}
                  </span>
                  <time
                    dateTime={new Date(request.started_at_ms).toISOString()}
                    className="shrink-0 tabular-nums"
                  >
                    {formatTimestamp(
                      new Date(request.started_at_ms).toISOString(),
                    ).slice(11)}
                  </time>
                  <span className="min-w-0 flex-1 truncate text-muted">
                    {(index === 0 ||
                      request.model !== data.items[index - 1].model ||
                      request.model_count > 1) && (
                      <>
                        {request.model || "Unknown model"}
                        {request.model_count > 1 &&
                          ` +${request.model_count - 1}`}
                      </>
                    )}
                  </span>
                  {request.failed > 0 && (
                    <span className="shrink-0 text-danger">
                      {request.failed} failed
                    </span>
                  )}
                  <span className="shrink-0 text-muted tabular-nums">
                    {formatLatency(request.ended_at_ms - request.started_at_ms)}
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-muted">
                    {expanded.has(request.key) ? "▾" : "▸"}
                  </span>
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
          <p className="text-xs text-muted" role="status">
            {loading
              ? "Updating requests…"
              : `${formatNumber(data.total)} requests`}
          </p>
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
  const [data, setData] = useState<TimelinePage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const id = detail.summary.key.slice(8);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError("");
    collectSessionPages(
      (page) =>
        api.timelines(
          { ...defaultFilter, range: "all" },
          "session",
          page,
          { parent_session_id: id },
          c.signal,
        ),
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
  }, [id, detail]);
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
      {data && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.items.map((child) => (
              <button
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
        </>
      )}
    </section>
  );
}
