import test from "node:test";
import assert from "node:assert/strict";
import {
  timelineGroups,
  timelineKey,
  timelineURL,
  observedEnd,
  barPosition,
} from "../src/lib/timeline.ts";

const row = (patch = {}) => ({
  event_key: "one",
  timestamp: "2026-09-29T12:00:00Z",
  latency_ms: 200,
  request_id: "",
  trace_id: "",
  ...patch,
});

test("legacy and modern records correlate; anonymous records stay independent", () => {
  const groups = timelineGroups([
    row({
      event_key: "later",
      trace_id: "request",
      request_id: "log",
      timestamp: "2026-09-29T12:00:02Z",
    }),
    row({ event_key: "anonymous-1" }),
    row({ event_key: "anonymous-2" }),
    row({ request_id: "request" }),
    row({
      event_key: "other",
      request_id: "request",
      trace_id: "different-trace",
    }),
  ]);
  assert.equal(groups.length, 4);
  assert.deepEqual(
    groups
      .find((g) => g.key === "request:request")
      .events.map((e) => e.event_key),
    ["one", "later"],
  );
});

test("additional model records remain separate even when execution or timestamp matches", () => {
  const records = [
    row({ event_key: "main", trace_id: "trace", execution_id: "exec" }),
    row({ event_key: "image", trace_id: "trace", execution_id: "exec" }),
  ];
  assert.equal(timelineGroups(records)[0].events.length, 2);
});

test("ID links encode query delimiters and slashes", () => {
  const key = timelineKey(row({ trace_id: "id&key=session:evil/?" }));
  const url = new URL(timelineURL(key), "https://example.com");
  assert.equal(url.searchParams.get("key"), key);
  assert.equal([...url.searchParams].length, 1);
});

test("overlapping intervals preserve actual start offsets and unknown duration stays visible", () => {
  const origin = Date.parse("2026-09-29T12:00:00Z");
  assert.deepEqual(barPosition(origin + 100, origin + 600, origin, 1000), {
    left: "10%",
    width: "50%",
    minWidth: "3px",
  });
  assert.deepEqual(barPosition(origin + 300, origin + 500, origin, 1000), {
    left: "30%",
    width: "20%",
    minWidth: "3px",
  });
  assert.equal(observedEnd(row({ latency_ms: -10 })), origin);
  assert.equal(barPosition(origin, origin, origin, 0).width, "0%");
});
