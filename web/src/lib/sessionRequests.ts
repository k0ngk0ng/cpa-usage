import type { TimelinePage } from "../api/types";

// HTTP pagination remains an implementation detail. Commit one complete list
// so refresh failures never replace the reader's list with an incomplete page.
export async function collectSessionPages(
  fetchPage: (page: number) => Promise<TimelinePage>,
  signal: AbortSignal,
): Promise<TimelinePage> {
  const items: TimelinePage["items"] = [];
  let page = 1;
  while (true) {
    signal.throwIfAborted();
    const next = await fetchPage(page);
    signal.throwIfAborted();
    items.push(...next.items);
    if (next.page_size <= 0)
      throw new Error("Invalid session response page size");
    if (page * next.page_size >= next.total) {
      return { ...next, items, page: 1 };
    }
    if (!next.items.length)
      throw new Error("Incomplete session response; refresh to retry");
    page++;
  }
}

// Preserve the currently visible request if late records insert earlier rows.
// Reading position is measured at commit time, so scrolling during a fetch is
// respected. Native scroll anchoring may already have applied the correction.
export function captureRequestPosition(
  root: HTMLElement | null,
): (() => void) | null {
  if (!root) return null;
  let scroller: HTMLElement | null = root.parentElement;
  while (
    scroller &&
    !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
  )
    scroller = scroller.parentElement;
  const top = scroller?.getBoundingClientRect().top || 0;
  const bottom = scroller?.getBoundingClientRect().bottom || window.innerHeight;
  const card = [
    ...root.querySelectorAll<HTMLElement>("[data-request-key]"),
  ].find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.bottom > top && rect.top < bottom;
  });
  if (!card) return null;
  const offset = card.getBoundingClientRect().top;
  return () => {
    if (!card.isConnected) return;
    const delta = card.getBoundingClientRect().top - offset;
    if (scroller) scroller.scrollTop += delta;
    else window.scrollBy(0, delta);
  };
}
