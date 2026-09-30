import test from "node:test";
import assert from "node:assert/strict";
import { collectSessionPages } from "../src/lib/sessionRequests.ts";

test("a long session becomes one complete chronological list", async () => {
  const all = Array.from({ length: 69 }, (_, i) => ({ key: `request:${i}` }));
  const calls = [];
  const result = await collectSessionPages(async (page) => {
    calls.push(page);
    return {
      items: all.slice((page - 1) * 20, page * 20),
      total: 69,
      page,
      page_size: 20,
    };
  }, new AbortController().signal);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.deepEqual(result.items, all);
  assert.equal(result.total, 69);
});
test("a failed refresh never returns a truncated replacement list", async () => {
  await assert.rejects(
    collectSessionPages(async (page) => {
      if (page === 2) throw new Error("connection lost");
      return { items: [{ key: "request:1" }], total: 2, page, page_size: 1 };
    }, new AbortController().signal),
    /connection lost/,
  );
});
test("changing sessions aborts old loading before another page is requested", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    collectSessionPages(async (page) => {
      calls++;
      controller.abort();
      return {
        items: [{ key: "request:old" }],
        total: 100,
        page,
        page_size: 1,
      };
    }, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});
test("empty sessions and invalid paging cannot cause a loading loop", async () => {
  const empty = await collectSessionPages(
    async (page) => ({ items: [], total: 0, page, page_size: 20 }),
    new AbortController().signal,
  );
  assert.deepEqual(empty.items, []);
  await assert.rejects(
    collectSessionPages(
      async (page) => ({ items: [], total: 40, page, page_size: 20 }),
      new AbortController().signal,
    ),
    /Incomplete/,
  );
});
