import type { UsageEventRecord } from "../api/types";

export function timelineKey(event: UsageEventRecord): string {
  const id = event.trace_id || event.request_id;
  return id ? `request:${id}` : `event:${event.event_key}`;
}

export function timelineURL(
  key: string,
  options: { event?: UsageEventRecord; eventsPath?: string } = {},
): string {
  const params = new URLSearchParams({ key });
  if (options.event) {
    params.set("focus_event", options.event.event_key);
    params.set("origin_request", timelineKey(options.event));
    if (options.event.session_id)
      params.set("context_session", options.event.session_id);
  }
  if (options.eventsPath)
    params.set("events", eventsReturnPath(options.eventsPath));
  return `/sessions?${params}`;
}

export function eventsReturnPath(path: string | null): string {
  return path === "/events" || path?.startsWith("/events?") ? path : "/events";
}

export function shortID(id: string): string {
  return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id;
}

export function sortTimelineEvents(
  events: UsageEventRecord[],
): UsageEventRecord[] {
  return [...events].sort(
    (a, b) =>
      Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
      a.event_key.localeCompare(b.event_key),
  );
}

export function timelineGroups(
  events: UsageEventRecord[],
): { key: string; events: UsageEventRecord[] }[] {
  const groups = new Map<string, UsageEventRecord[]>();
  for (const event of sortTimelineEvents(events)) {
    const key = timelineKey(event);
    const group = groups.get(key) || [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups].map(([key, events]) => ({ key, events }));
}

export function observedEnd(event: UsageEventRecord): number {
  return Date.parse(event.timestamp) + Math.max(0, event.latency_ms);
}

export function barPosition(
  start: number,
  end: number,
  origin: number,
  duration: number,
) {
  const left = Math.max(
    0,
    Math.min(100, ((start - origin) / Math.max(1, duration)) * 100),
  );
  const width = Math.max(
    0,
    Math.min(100 - left, ((end - start) / Math.max(1, duration)) * 100),
  );
  return { left: `${left}%`, width: `${width}%`, minWidth: "3px" };
}
