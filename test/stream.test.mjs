import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InvalidApiKeyError,
  OxinsiderApiClient,
  StreamProtocolError,
  streamFeed,
} from "../dist/index.js";
import { apiError, header, jsonResponse, mockFetch, sseResponse } from "./helpers.mjs";

const KEY = "oxi_sk_live_testkey";

function clientFor(fetchImpl) {
  return new OxinsiderApiClient({ apiKey: KEY, fetch: fetchImpl });
}

async function drain(iterable) {
  const frames = [];
  for await (const frame of iterable) frames.push(frame);
  return frames;
}

/** Drain until the stream throws; return the frames seen and the error. */
async function drainUntilError(iterable) {
  const frames = [];
  try {
    for await (const frame of iterable) frames.push(frame);
  } catch (error) {
    return { frames, error };
  }
  assert.fail("the stream ended without an error");
}

const event = (seq, type = "WhaleTradesInserted") =>
  `id: ${seq}\ndata: ${JSON.stringify({ seq, published_at: "2026-09-22T00:00:00Z", type })}\n\n`;

test("keep-alives are skipped, CRLF and split chunks decode, and the cursor follows seq", async () => {
  const fetchImpl = mockFetch(() =>
    sseResponse([
      ": keep-alive\n\n",
      event(41),
      'id: 42\r\ndata: {"seq":42,"type":"wallet_grade_changed"}\r\n\r\n',
      "id: 4",
      '3\ndata: {"seq":43,',
      '"type":"WhaleTradesInserted"}\n\n',
      ": keep-alive\n\n",
    ]),
  );
  const cursor = {};
  const frames = await drain(
    streamFeed(clientFor(fetchImpl), {
      event: ["WhaleTradesInserted", "wallet_grade_changed"],
      min_grade: "S",
      lastEventId: 40,
      cursor,
    }),
  );
  assert.deepEqual(
    frames.map((f) => [f.kind, f.seq, f.envelope.type]),
    [
      ["event", 41, "WhaleTradesInserted"],
      ["event", 42, "wallet_grade_changed"],
      ["event", 43, "WhaleTradesInserted"],
    ],
  );
  assert.equal(cursor.seq, 43);

  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url.pathname, "/api/v1/stream");
  assert.equal(url.searchParams.get("event"), "WhaleTradesInserted,wallet_grade_changed");
  assert.equal(url.searchParams.get("min_grade"), "S");
  assert.equal(header(init, "last-event-id"), "40");
  assert.equal(header(init, "accept"), "text/event-stream");
  assert.equal(header(init, "authorization"), `Bearer ${KEY}`);
});

test("a resync marker is yielded and reported, and does not move the cursor", async () => {
  const marker = {
    type: "resync",
    completeness: { status: "partial", reason: "cursor_expired" },
    from_sequence: 1,
    to_sequence: 9,
  };
  const fetchImpl = mockFetch(() =>
    sseResponse([event(5), `event: resync\nid: 9\ndata: ${JSON.stringify(marker)}\n\n`, event(10)]),
  );
  const cursor = {};
  const resyncs = [];
  const frames = await drain(
    streamFeed(clientFor(fetchImpl), { cursor, onResync: (m) => resyncs.push(m) }),
  );
  assert.deepEqual(frames.map((f) => f.kind), ["event", "resync", "event"]);
  assert.equal(frames[1].marker.completeness.reason, "cursor_expired");
  assert.equal(resyncs.length, 1);
  assert.equal(cursor.seq, 10);
});

for (const [name, frame, reason] of [
  ["invalid JSON", "id: 8\ndata: {not json\n\n", "invalid_json"],
  ["a JSON value that is not an object", "id: 8\ndata: [1,2]\n\n", "invalid_envelope"],
  ["no seq and no id", 'data: {"type":"WhaleTradesInserted"}\n\n', "unusable_sequence"],
  ["a resync marker that is not a resync object", "event: resync\nid: 8\ndata: [1]\n\n", "invalid_resync"],
]) {
  test(`${name} ends the stream with StreamProtocolError ${reason}, keeping the last good seq`, async () => {
    const fetchImpl = mockFetch(() => sseResponse([event(7), frame, event(9)]));
    const { frames, error } = await drainUntilError(streamFeed(clientFor(fetchImpl)));
    assert.ok(error instanceof StreamProtocolError, String(error));
    assert.equal(error.reason, reason);
    assert.equal(error.lastSeq, 7);
    assert.deepEqual(frames.map((f) => f.seq), [7]);
  });
}

test("a frame past maxFrameBytes with no delimiter is frame_too_large", async () => {
  const fetchImpl = mockFetch(() =>
    sseResponse([event(1), `id: 2\ndata: {"seq":2,"type":"x","pad":"${"a".repeat(4096)}`]),
  );
  const { frames, error } = await drainUntilError(
    streamFeed(clientFor(fetchImpl), { maxFrameBytes: 1024 }),
  );
  assert.ok(error instanceof StreamProtocolError, String(error));
  assert.equal(error.reason, "frame_too_large");
  assert.equal(error.lastSeq, 1);
  assert.equal(frames.length, 1);
});

test("a 200 that is not text/event-stream is unexpected_media_type", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(200, { ok: true }));
  const { error } = await drainUntilError(streamFeed(clientFor(fetchImpl)));
  assert.ok(error instanceof StreamProtocolError, String(error));
  assert.equal(error.reason, "unexpected_media_type");
});

test("a non-2xx answer to the stream request is the typed API error", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(401, apiError("invalid_api_key", "Invalid API key")));
  const { error } = await drainUntilError(streamFeed(clientFor(fetchImpl)));
  assert.ok(error instanceof InvalidApiKeyError, String(error));
  assert.equal(error.status, 401);
  assert.equal(error.requestId, "req_test");
});
