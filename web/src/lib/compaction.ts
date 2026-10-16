import type { EventLogEntry } from "../api/types";

type Item = Record<string, unknown>;
export interface CompactionReport {
  reason: "endpoint" | "trigger" | "response" | "output";
  exchange?: number;
  upstream: boolean;
  completed: boolean;
  comparisonAvailable: boolean;
  input: Item[];
  output: Item[];
  retained: Item[];
  replaced: Item[];
  requestRaw: string;
  responseRaw: string;
  truncated: boolean;
}

export function isCompactEndpoint(endpoint = ""): boolean {
  try {
    return /\/responses\/compact\/?$/.test(new URL(endpoint, "http://log.local").pathname);
  } catch { return false; }
}

function record(value: unknown): value is Item {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parse(raw: string): Item | null {
  try { const value = JSON.parse(raw); return record(value) ? value : null; } catch { return null; }
}
function body(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").trim();
  return text.replace(/^Status:\s*\d{3}\s*\n(?:[^\n:]+:[^\n]*\n)*\n/, "").replace(/^Status:\s*\d{3}(?:\n[^\n:]+:[^\n]*)*$/, "");
}
export function isCompactionItem(item: Item): boolean {
  return item.type === "compaction" || item.type === "compaction_summary";
}
function items(value: unknown): Item[] { return Array.isArray(value) ? value.filter(record) : []; }

// Only explicit terminal events establish completion. An output_item.done can
// precede a failed/disconnected response; it is useful evidence, not success.
function response(raw: string) {
  const text = body(raw);
  const direct = parse(text);
  const events = direct ? [direct] : text.split(/\r?\n/).flatMap(line => {
    const event = parse(line.replace(/^\s*data:\s?/, ""));
    return event ? [event] : [];
  });
  let output: Item[] = [];
  let completed = false;
  let compactObject = false;
  for (const event of events) {
    const nested = record(event.response) ? event.response : event;
    if (Array.isArray(nested.output)) output = items(nested.output);
    if (event.type === "response.output_item.done" && record(event.item)) output.push(event.item);
    compactObject ||= nested.object === "response.compaction";
    if (event.type === "response.completed") completed = true;
    else if (!event.type && Array.isArray(event.output)) completed = true;
    if (event.error || nested.error || ["response.failed", "response.incomplete", "response.cancelled", "error"].includes(String(event.type)) || ["failed", "incomplete", "cancelled"].includes(String(nested.status))) completed = false;
  }
  if (/^\s*Status:\s*[45]\d{2}\b/.test(raw)) completed = false;
  return { output, completed, compactObject };
}

// Compare occurrences using content, not IDs (compact may assign new IDs).
// Preserve every non-transport field so changed messages are not "retained".
function identity(item: Item): string {
  const value = { ...item };
  delete value.id;
  delete value.status;
  if (value.role && (!value.type || value.type === "message")) {
    delete value.type;
    if (typeof value.content === "string") value.content = [{ type: "text", text: value.content }];
    else if (Array.isArray(value.content)) value.content = value.content.map(part =>
      record(part) && ["input_text", "output_text"].includes(String(part.type)) ? { ...part, type: "text" } : part);
  }
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : record(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v;
  return JSON.stringify(canonical(value));
}

function report(requestRaw: string, responseRaw: string, endpoint: string, truncated: boolean, upstream: boolean): CompactionReport | null {
  const request = parse(requestRaw);
  const rawInput = typeof request?.input === "string" ? [{ role: "user", content: request.input }] : items(request?.input);
  const trigger = rawInput.some(item => item.type === "compaction_trigger");
  const input = rawInput.filter(item => item.type !== "compaction_trigger");
  const result = response(responseRaw);
  const existing = new Set(input.filter(isCompactionItem).map(identity));
  const newCheckpoint = result.output.some(item => isCompactionItem(item) && !existing.has(identity(item)));
  const reason = isCompactEndpoint(endpoint) ? "endpoint" : trigger ? "trigger" : result.compactObject ? "response" : newCheckpoint ? "output" : null;
  if (!reason) return null;
  const completed = result.completed && newCheckpoint && !truncated;
  // Automatic inline compaction can return a delta with a normal answer, not
  // a replacement transcript. Never subtract that delta from the input.
  const comparisonAvailable = completed && !!request && input.length > 0 && !request.previous_response_id && reason !== "output";
  const retained: Item[] = [], replaced: Item[] = [];
  if (comparisonAvailable) {
    const counts = new Map<string, number>();
    for (const item of result.output) { const key = identity(item); counts.set(key, (counts.get(key) || 0) + 1); }
    for (const item of input) {
      const key = identity(item), count = counts.get(key) || 0;
      if (count) { retained.push(item); counts.set(key, count - 1); } else replaced.push(item);
    }
  }
  return { reason, upstream, completed, comparisonAvailable, input, output: result.output, retained, replaced, requestRaw, responseRaw, truncated };
}

function websocketReports(timeline: string, truncated: boolean, upstream: boolean): CompactionReport[] {
  const reports: CompactionReport[] = [];
  let request = "", responses: string[] = [], exchange = 0;
  const flush = () => {
    if (!request) return;
    const found = report(request, responses.join("\n"), "", truncated, upstream);
    if (found) reports.push({ ...found, exchange });
  };
  // CPA frames use Timestamp / Event headers, followed by one JSON payload.
  for (const match of timeline.matchAll(/Event: (?:api\.)?websocket\.(request|response)\r?\n([\s\S]*?)(?=\r?\nTimestamp: |$)/g)) {
    if (match[1] === "request") { flush(); request = match[2].replace(/^[\s\S]*?\r?\nBody:\r?\n/, "").trim(); responses = []; exchange++; }
    else responses.push(match[2].trim());
  }
  flush();
  return reports;
}

export function compactionReports(entry: EventLogEntry, endpoint = ""): CompactionReport[] {
  if (entry.websocket_timeline?.trim()) return websocketReports(entry.websocket_timeline, !!entry.websocket_timeline_truncated, false);
  const final = body(entry.response_body || "");
  const last = [...(entry.api_responses || [])].reverse().find(attempt => attempt.body?.trim());
  const upstream = entry.api_websocket_timeline?.trim()
    ? websocketReports(entry.api_websocket_timeline, !!entry.api_websocket_timeline_truncated, true) : [];
  if (!final && !last && upstream.length) return upstream;
  const raw = final ? entry.response_body : last?.status ? `Status: ${last.status}\n\n${last.body}` : last?.body || "";
  const found = report(entry.request_body, raw, entry.info?.URL || endpoint,
    !!entry.request_body_truncated || (final ? !!entry.response_body_truncated : !!last?.body_truncated), !final && !!last);
  if (found) return [found];
  return upstream;
}
