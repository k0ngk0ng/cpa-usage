import type { EventLogEntry } from "../api/types";
import type { Turn } from "./protocol";

// Show the last input exchange first; older context remains available in full.
// This is a presentation boundary, not a claim that these turns are new deltas.
export function splitRequestContext(turns: Turn[]) {
  let start = turns.length - 1;
  while (
    start > 0 &&
    !["assistant", "model", "system", "developer"].includes(
      turns[start - 1].role,
    )
  )
    start--;
  if (
    start < 0 ||
    ["assistant", "model", "system", "developer"].includes(turns[start].role)
  )
    start = 0;
  return { context: turns.slice(0, start), input: turns.slice(start) };
}

export function sessionResponse(entry: EventLogEntry) {
  const finalBody = responseBodyContent(entry.response_body);
  if (finalBody.trim())
    return {
      body: finalBody,
      upstream: false,
      truncated: entry.response_body_truncated,
    };
  const attempts = entry.api_responses || [];
  const last = [...attempts].reverse().find((a) => a.body?.trim());
  return {
    body: last?.body || "",
    upstream: !!last,
    truncated: !!last?.body_truncated,
  };
}

// CPA's RESPONSE section includes status/headers before the body. Keep the
// original log untouched and remove only a recognizable HTTP-like prefix.
export function responseBodyContent(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").trimStart();
  const lines = normalized.split("\n");
  if (!/^Status:\s*\d{3}\s*$/.test(lines[0])) return raw;
  let i = 1;
  while (i < lines.length && /^[\w!#$%&'*+.^`|~-]+:[^\n]*$/.test(lines[i])) i++;
  if (i === lines.length) return "";
  if (lines[i] === "") return lines.slice(i + 1).join("\n");
  return raw;
}
