import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InternalServerError,
  OxinsiderApiClient,
  RateLimitUnavailableError,
  RateLimitedError,
  retryEligibility,
} from "../dist/index.js";
import { apiError, header, jsonResponse, listPage, mockFetch } from "./helpers.mjs";

const KEY = "oxi_sk_live_testkey";
const client = (fetchImpl, options = {}) =>
  new OxinsiderApiClient({ apiKey: KEY, fetch: fetchImpl, ...options });

test("a 429 is retried after its Retry-After, and the retry succeeds", async () => {
  const fetchImpl = mockFetch((_url, _init, index) =>
    index === 0
      ? jsonResponse(429, apiError("rate_limited", "Slow down"), { "retry-after": "1" })
      : jsonResponse(200, listPage([{ address: "0xabc" }])),
  );
  const started = performance.now();
  const board = await client(fetchImpl).listLeaderboard({ limit: 1 });
  const waited = performance.now() - started;
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(board.data[0].address, "0xabc");
  assert.ok(waited >= 990, `waited ${waited} ms, Retry-After asked for 1000`);
  assert.ok(waited < 5_000, `waited ${waited} ms`);
});

test("a Retry-After past the 60 s ceiling is thrown for the caller to schedule, not slept", async () => {
  const fetchImpl = mockFetch(() =>
    jsonResponse(429, apiError("rate_limited", "Slow down"), { "retry-after": "120" }),
  );
  const started = performance.now();
  await assert.rejects(client(fetchImpl).listLeaderboard(), RateLimitedError);
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(performance.now() - started < 1_000);
});

test("maxRetries bounds the attempts, and 0 sends exactly one request", async () => {
  const unavailable = () =>
    jsonResponse(503, apiError("rate_limit_unavailable", "Try again"), { "retry-after": "0" });
  const retried = mockFetch(unavailable);
  await assert.rejects(client(retried, { maxRetries: 1 }).listLeaderboard(), RateLimitUnavailableError);
  assert.equal(retried.calls.length, 2);
  const once = mockFetch(unavailable);
  await assert.rejects(client(once).listLeaderboard({}, { maxRetries: 0 }), RateLimitUnavailableError);
  assert.equal(once.calls.length, 1);
});

test("a 500 is never retried", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(500, apiError("internal_error", "Boom")));
  await assert.rejects(client(fetchImpl).listLeaderboard(), InternalServerError);
  assert.equal(fetchImpl.calls.length, 1);
});

test("an unkeyed write is not retried; a keyed one is, with the same key and bytes", async () => {
  const body = { name: "Large trades", url: "https://example.com/hook", event_types: ["whale_trades_inserted"] };
  const unkeyed = mockFetch(() => jsonResponse(503, apiError("rate_limit_unavailable", "Try again"), { "retry-after": "0" }));
  await assert.rejects(client(unkeyed).call("createWebhook", { body }), RateLimitUnavailableError);
  assert.equal(unkeyed.calls.length, 1);

  const keyed = mockFetch((_url, _init, index) =>
    index === 0
      ? jsonResponse(503, apiError("rate_limit_unavailable", "Try again"), { "retry-after": "0" })
      : jsonResponse(200, { object: "webhook_endpoint", data: { id: 1 }, meta: { request_id: "req_test" } }),
  );
  await client(keyed).call("createWebhook", { body, idempotencyKey: "idem-1" });
  assert.equal(keyed.calls.length, 2);
  for (const { init } of keyed.calls) {
    assert.equal(header(init, "idempotency-key"), "idem-1");
    assert.equal(init.body, JSON.stringify(body));
  }
});

test("a key on an operation the API does not replay is refused before sending", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(200, {}));
  await assert.rejects(
    client(fetchImpl).call("verifyWebhook", { path: { id: 1 }, body: {}, idempotencyKey: "k" }),
    /does not honour Idempotency-Key/,
  );
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(retryEligibility({ method: "GET", operationId: "listLeaderboard" }), "read");
  assert.equal(retryEligibility({ method: "POST", operationId: "batchGetTraders" }), "read");
  assert.equal(retryEligibility({ method: "POST", operationId: "createWebhook" }), "keyed");
  assert.equal(retryEligibility({ method: "POST", operationId: "verifyWebhook" }), "never");
});
