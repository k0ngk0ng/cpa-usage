import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useRefreshTick } from "../lib/refresh";
import { shortID } from "../lib/timeline";
import type { SessionLabel } from "../api/types";

// Keep discovery off the usage-list critical path and limit log lookup traffic.
const cache = new Map<string, { value: SessionLabel; until: number }>();
let active = 0;
const queue = new Set<() => void>();
function acquire(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      queue.delete(start);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const start = () => {
      if (signal.aborted) {
        abort();
        return;
      }
      if (active >= 2) {
        queue.add(start);
        return;
      }
      queue.delete(start);
      signal.removeEventListener("abort", abort);
      active++;
      resolve(() => {
        active--;
        queue.values().next().value?.();
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    start();
  });
}
async function lookup(id: string, signal: AbortSignal, force: boolean) {
  const release = await acquire(signal);
  try {
    const cached = cache.get(id);
    if (!force && cached && cached.until > Date.now()) return cached.value;
    const value = await api.sessionLabel(id, signal);
    if (cache.size >= 200 && !cache.has(id))
      cache.delete(cache.keys().next().value!);
    cache.set(id, { value, until: Date.now() + 60_000 });
    return value;
  } finally {
    release();
  }
}

export default function SessionName({
  id,
  fullID = false,
  revision = 0,
}: {
  id: string;
  fullID?: boolean;
  revision?: number;
}) {
  const [label, setLabel] = useState<SessionLabel | null>(
    () => cache.get(id)?.value || null,
  );
  const tick = useRefreshTick();
  useEffect(() => {
    const c = new AbortController();
    setLabel(cache.get(id)?.value || null);
    void (async () => {
      if (!cache.has(id)) {
        const stored = await api.sessionLabel(id, c.signal, true);
        if (c.signal.aborted) return;
        setLabel(stored);
      }
      // Further batches resume on Refresh. Opening a full request log also
      // captures naming evidence, including logs too large for card discovery.
      for (let batch = 0; batch < 3; batch++) {
        const next = await lookup(
          id,
          c.signal,
          tick > 0 || revision > 0 || batch > 0,
        );
        if (c.signal.aborted) return;
        setLabel(next);
        if (!next.more) break;
      }
    })().catch(() => {
      /* A missing log source must not hide session navigation. */
    });
    return () => c.abort();
  }, [id, tick, revision]);
  const name = label?.title;
  return (
    <span className="block min-w-0">
      {name && (
        <span
          className="block break-words text-sm font-medium text-ink"
          title={name}
        >
          {name}
        </span>
      )}
      {name && (
        <span
          className="mt-1 block text-[10px] text-muted"
          title={
            label.source === "generated_title"
              ? "Captured from a naming request associated with this session."
              : "Excerpt from a retained user message; not the client’s automatic title."
          }
        >
          {label.source === "generated_title"
            ? "Captured title"
            : "Prompt preview"}
        </span>
      )}
      <span
        className={`${name ? "mt-1 text-[10px] text-muted" : "text-xs"} block break-all font-mono`}
        title={id}
      >
        {fullID ? id : shortID(id)}
      </span>
    </span>
  );
}
