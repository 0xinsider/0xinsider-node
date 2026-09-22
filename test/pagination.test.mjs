import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OxinsiderApiClient,
  PaginationError,
  collect,
  paginate,
  paginatePages,
  paginationResumePoint,
} from "../dist/index.js";
import { jsonResponse, listPage, mockFetch } from "./helpers.mjs";

const KEY = "oxi_sk_live_testkey";

/** Serve `pages[cursor ?? "first"]` for GET /api/v1/whale-trades. */
function pagedFetch(pages) {
  return mockFetch((url) => {
    const page = pages[url.searchParams.get("cursor") ?? "first"];
    assert.ok(page, `unexpected cursor ${url.searchParams.get("cursor")}`);
    return jsonResponse(200, page);
  });
}

const client = (fetchImpl) => new OxinsiderApiClient({ apiKey: KEY, fetch: fetchImpl });

test("the walk follows next_cursor and stops at has_more: false, whatever next_cursor says", async () => {
  const fetchImpl = pagedFetch({
    first: listPage([{ id: 1 }, { id: 2 }], { hasMore: true, nextCursor: "c1" }),
    c1: listPage([{ id: 3 }], { hasMore: false, nextCursor: "c2" }),
  });
  const items = await collect(client(fetchImpl), "listWhaleTrades", { query: { limit: 2 } });
  assert.deepEqual(items.map((item) => item.id), [1, 2, 3]);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].url.searchParams.get("limit"), "2");
  assert.equal(fetchImpl.calls[1].url.searchParams.get("cursor"), "c1");
});

test("has_more: true with no next_cursor is missing_cursor, and the page travels on the error", async () => {
  const fetchImpl = pagedFetch({
    first: listPage([{ id: 1 }], { hasMore: true, nextCursor: "c1" }),
    c1: listPage([{ id: 2 }], { hasMore: true, nextCursor: null }),
  });
  const seen = [];
  await assert.rejects(
    (async () => {
      for await (const item of paginate(client(fetchImpl), "listWhaleTrades")) seen.push(item.id);
    })(),
    (error) => {
      assert.ok(error instanceof PaginationError, String(error));
      assert.equal(error.reason, "missing_cursor");
      assert.equal(error.cursor, "c1");
      assert.deepEqual(error.page.data, [{ id: 2 }]);
      assert.deepEqual(paginationResumePoint(error), { cursor: "c1", pagesFetched: 1 });
      return true;
    },
  );
  assert.deepEqual(seen, [1]);
  assert.equal(fetchImpl.calls.length, 2);
});

test("a next_cursor the walk already requested is repeated_cursor, before a duplicate request", async () => {
  const fetchImpl = pagedFetch({
    first: listPage([{ id: 1 }], { hasMore: true, nextCursor: "c1" }),
    c1: listPage([{ id: 2 }], { hasMore: true, nextCursor: "c1" }),
  });
  await assert.rejects(collect(client(fetchImpl), "listWhaleTrades"), (error) => {
    assert.ok(error instanceof PaginationError, String(error));
    assert.equal(error.reason, "repeated_cursor");
    assert.equal(error.nextCursor, "c1");
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2);
});

test("maxPages stops the walk and progress keeps the continuation", async () => {
  const fetchImpl = pagedFetch({
    first: listPage([{ id: 1 }], { hasMore: true, nextCursor: "c1" }),
    c1: listPage([{ id: 2 }], { hasMore: true, nextCursor: "c2" }),
  });
  const progress = {};
  const pages = [];
  for await (const page of paginatePages(client(fetchImpl), "listWhaleTrades", { maxPages: 2, progress })) {
    pages.push(page);
  }
  assert.equal(pages.length, 2);
  assert.equal(progress.stoppedBy, "max_pages");
  assert.equal(progress.nextCursor, "c2");
  assert.equal(fetchImpl.calls.length, 2);
  await assert.rejects(paginatePages(client(fetchImpl), "listWhaleTrades", { maxPages: 0 }).next(), RangeError);
  assert.equal(fetchImpl.calls.length, 2);
});
