import { Link, useLocation } from "react-router-dom";
import type { UsageEventRecord } from "../api/types";
import { timelineKey, timelineURL } from "../lib/timeline";

// Keep the operator's Events filters and selected usage row when following a call.
export default function EventTraceLinks({
  event,
  onNavigate,
}: {
  event: UsageEventRecord;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const eventsPath =
    location.pathname === "/events"
      ? location.pathname + location.search
      : new URLSearchParams(location.search).get("events") || "/events";
  const options = { event, eventsPath };
  return (
    <div
      className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {event.session_id ? (
        <Link
          className="text-accent hover:underline"
          to={timelineURL(`session:${event.session_id}`, options)}
          onClick={onNavigate}
        >
          View session →
        </Link>
      ) : (
        <span
          className="text-muted"
          title="This usage record does not include a session ID."
        >
          Session unavailable
        </span>
      )}
      <Link
        className="text-accent hover:underline"
        to={timelineURL(timelineKey(event), options)}
        onClick={onNavigate}
      >
        View request →
      </Link>
    </div>
  );
}
