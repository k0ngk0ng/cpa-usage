import { useEffect, useState } from "react";
import clsx from "clsx";
import { api } from "../api/client";
import type {
  EventLogEntry,
  TimelineDetail,
  UsageEventRecord,
} from "../api/types";
import EventLogModal, { ChatView, responseToTurn } from "./EventLogModal";
import { extractRequestTurns } from "../lib/protocol";
import { sessionResponse, splitRequestContext } from "../lib/sessionContent";
import { barPosition, observedEnd, sortTimelineEvents } from "../lib/timeline";
import { formatLatency, formatNumber } from "../lib/utils";

export default function RequestConversation({
  requestKey,
  snapshot = 0,
  focusEvent = "",
}: {
  requestKey: string;
  snapshot?: number;
  focusEvent?: string;
}) {
  const [detail, setDetail] = useState<TimelineDetail | null>(null);
  const [selected, setSelected] = useState(focusEvent);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [log, setLog] = useState<UsageEventRecord | null>(null);
  useEffect(() => {
    const c = new AbortController();
    setDetail(null);
    setError("");
    setLoading(true);
    api
      .timelineDetail(requestKey, 0, snapshot, c.signal, focusEvent)
      .then((d) => {
        if (!c.signal.aborted) setDetail(d);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [requestKey, snapshot, focusEvent, revision]);
  const events = sortTimelineEvents(
    detail
      ? [
          ...detail.items,
          ...(detail.focused_event &&
          !detail.items.some(
            (e) => e.event_key === detail.focused_event!.event_key,
          )
            ? [detail.focused_event]
            : []),
        ]
      : [],
  );
  const event =
    events.find((e) => e.event_key === selected) ||
    events.find((e) => e.request_id) ||
    events[0];
  const duration = detail
    ? Math.max(1, detail.summary.ended_at_ms - detail.summary.started_at_ms)
    : 1;
  async function more() {
    if (!detail) return;
    setLoading(true);
    setError("");
    try {
      const next = await api.timelineDetail(
        requestKey,
        detail.next_cursor,
        detail.snapshot,
      );
      setDetail({
        ...next,
        focused_event: detail.focused_event,
        items: [...detail.items, ...next.items],
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="min-w-0 space-y-4 border-t border-border p-3 sm:p-4">
      {loading && !detail && (
        <p role="status" className="text-xs text-muted">
          Loading request…
        </p>
      )}
      {error && (
        <div role="alert" className="text-sm text-danger">
          {error}{" "}
          <button
            className="text-accent"
            onClick={() => setRevision((v) => v + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {detail && (
        <>
          <details>
            <summary className="cursor-pointer text-xs text-muted">
              Execution timeline · {detail.summary.records} usage records ·{" "}
              {formatLatency(duration)} observed
            </summary>
            <p className="my-2 text-[11px] text-muted">
              Bars show reported usage intervals, not a distributed span tree.
              Select an execution to read its associated request log; executions
              sharing a request log share the same input and final response.
            </p>
            <div className="space-y-1" aria-label="Execution waterfall">
              {events.map((e) => (
                <button
                  key={e.event_key}
                  onClick={() => setSelected(e.event_key)}
                  aria-pressed={event?.event_key === e.event_key}
                  className={clsx(
                    "grid w-full grid-cols-[100px_minmax(0,1fr)] items-center gap-3 rounded border p-2 text-left sm:grid-cols-[200px_minmax(0,1fr)]",
                    event?.event_key === e.event_key
                      ? "border-accent bg-accent/5"
                      : "border-border",
                  )}
                >
                  <span className="min-w-0 text-xs">
                    <span className="block truncate">
                      {e.model || "Unknown model"}
                    </span>
                    <span className={e.failed ? "text-danger" : "text-muted"}>
                      {e.failed
                        ? `Failed ${e.fail_status_code || ""}`
                        : "Success"}
                      {e.timestamp_inferred && " · inferred time"}
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className="relative block h-3 rounded bg-panel2">
                      <span
                        className={clsx(
                          "absolute h-full rounded",
                          e.failed ? "bg-danger" : "bg-accent",
                        )}
                        style={barPosition(
                          Date.parse(e.timestamp),
                          observedEnd(e),
                          detail.summary.started_at_ms,
                          duration,
                        )}
                      />
                    </span>
                    <span className="mt-1 block text-right text-[10px] text-muted">
                      {formatLatency(e.latency_ms)} ·{" "}
                      {formatNumber(e.total_tokens)} tokens
                      {e.ttft_ms > 0 && ` · TTFT ${formatLatency(e.ttft_ms)}`}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {detail.next_cursor > 0 && (
              <button
                className="mt-2 text-xs text-accent"
                disabled={loading}
                onClick={more}
              >
                {loading ? "Loading…" : "Load more executions"}
              </button>
            )}
          </details>
          {event?.request_id ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-muted">Request input → response</span>
                <button className="text-accent" onClick={() => setLog(event)}>
                  Open request log →
                </button>
              </div>
              <RequestLogContent
                key={event.request_id}
                requestID={event.request_id}
              />
            </>
          ) : (
            <p className="text-sm text-muted">
              Content unavailable: this usage record has no request log ID.
            </p>
          )}
        </>
      )}
      {log && <EventLogModal event={log} onClose={() => setLog(null)} />}
    </div>
  );
}

function RequestLogContent({ requestID }: { requestID: string }) {
  const [entry, setEntry] = useState<EventLogEntry | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError("");
    api
      .eventLog(requestID, undefined, c.signal)
      .then((result) => {
        if (c.signal.aborted) return;
        setEntry(result.entry || null);
        if (!result.found || !result.entry)
          setError(
            "Request log not retained or not available. Usage and session links remain available.",
          );
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(`Request content unavailable: ${e.message}`);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [requestID, revision]);
  if (loading)
    return (
      <p role="status" className="text-xs text-muted">
        Loading request and response…
      </p>
    );
  if (error)
    return (
      <p role="status" className="text-sm text-muted">
        {error}{" "}
        <button
          className="text-accent"
          onClick={() => setRevision((v) => v + 1)}
        >
          Retry log
        </button>
      </p>
    );
  if (!entry) return null;
  return <RequestResponseContent entry={entry} />;
}

export function RequestResponseContent({ entry }: { entry: EventLogEntry }) {
  const turns = extractRequestTurns(entry.request_body);
  const { context, input } = splitRequestContext(turns || []);
  const response = sessionResponse(entry);
  const output = responseToTurn(response.body);
  return (
    <div className="min-w-0 space-y-3">
      <h4 className="text-xs font-semibold">Request input</h4>
      {entry.request_body_truncated && (
        <p className="text-xs text-warn">
          Request content is truncated in the available log.
        </p>
      )}
      {context.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted">
            Earlier context · {context.length} messages
          </summary>
          <div className="mt-2">
            <ChatView turns={context} contentOnly />
          </div>
        </details>
      )}
      {context.length > 0 && (
        <p className="text-[11px] text-muted">
          Latest input exchange in this request. Expand earlier context for the
          full supplied history.
        </p>
      )}
      {input.length ? (
        <ChatView turns={input} toolContext={turns || undefined} contentOnly />
      ) : (
        <p className="text-xs text-muted">
          {entry.request_body.trim()
            ? "Could not organize this request body. Open request log to inspect it."
            : "No request body was retained."}
        </p>
      )}
      <h4 className="text-xs font-semibold">
        {response.upstream ? "Last logged upstream response" : "Response"}
      </h4>
      {response.upstream && (
        <p className="text-xs text-warn">
          Final client response is unavailable. This is the last upstream
          response retained in the request log; it is not mapped to a specific
          execution.
        </p>
      )}
      {response.truncated && (
        <p className="text-xs text-warn">
          Response content is truncated in the available log.
        </p>
      )}
      {output ? (
        <ChatView turns={[output]} contentOnly />
      ) : (
        <p className="text-xs text-muted">No response body was retained.</p>
      )}
    </div>
  );
}
