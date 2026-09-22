import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AccountLockedError,
  BadRequestError,
  CursorExpiredError,
  DatabaseUnavailableError,
  ForbiddenError,
  InternalServerError,
  InvalidApiKeyError,
  NotFoundError,
  OxinsiderApiClient,
  OxinsiderApiError,
  PickNotReleasedError,
  RateLimitUnavailableError,
  RateLimitedError,
  SandboxApiKeyError,
  ServerTimeoutError,
  SubscriptionRequiredError,
  errorFromResponse,
} from "../dist/index.js";
import { apiError, jsonResponse, mockFetch } from "./helpers.mjs";

test("each documented error code dispatches to its class", () => {
  const cases = [
    [400, "bad_request", BadRequestError],
    [401, "invalid_api_key", InvalidApiKeyError],
    [402, "subscription_required", SubscriptionRequiredError],
    [403, "forbidden", ForbiddenError],
    [404, "not_found", NotFoundError],
    [423, "account_locked", AccountLockedError],
    [429, "rate_limited", RateLimitedError],
    [503, "rate_limit_unavailable", RateLimitUnavailableError],
    [408, "request_timeout", ServerTimeoutError],
    [500, "internal_error", InternalServerError],
  ];
  for (const [status, code, cls] of cases) {
    const error = errorFromResponse(status, apiError(code, "message"));
    assert.ok(error instanceof cls, `${code} -> ${error.constructor.name}`);
    assert.ok(error instanceof OxinsiderApiError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, "message");
    assert.equal(error.requestId, "req_test");
  }
});

test("reason is more specific than code and wins", () => {
  const cases = [
    [503, "rate_limit_unavailable", "database_unavailable", DatabaseUnavailableError],
    [404, "not_found", "pick_not_released", PickNotReleasedError],
    [400, "bad_request", "cursor_expired", CursorExpiredError],
    [401, "invalid_api_key", "sandbox_api_key", SandboxApiKeyError],
  ];
  for (const [status, code, reason, cls] of cases) {
    const error = errorFromResponse(status, apiError(code, "message", { reason }));
    assert.ok(error instanceof cls, `${reason} -> ${error.constructor.name}`);
    assert.equal(error.reason, reason);
  }
});

test("an unknown code falls back on the status, and an unknown status on the base class", () => {
  assert.ok(errorFromResponse(429, apiError("brand_new_code", "m")) instanceof RateLimitedError);
  assert.ok(errorFromResponse(502, null) instanceof InternalServerError);
  const teapot = errorFromResponse(418, apiError("brand_new_code", "m"));
  assert.equal(teapot.constructor, OxinsiderApiError);
  assert.equal(teapot.code, "brand_new_code");
});

test("a failed call throws the typed error with Retry-After and the request id", async () => {
  const fetchImpl = mockFetch(() =>
    jsonResponse(429, apiError("rate_limited", "Slow down"), { "retry-after": "120" }),
  );
  const client = new OxinsiderApiClient({ apiKey: "oxi_sk_live_testkey", fetch: fetchImpl });
  await assert.rejects(client.getTrader("swisstony"), (error) => {
    assert.ok(error instanceof RateLimitedError, String(error));
    assert.equal(error.retryAfterSeconds, 120);
    assert.equal(error.requestId, "req_test");
    return true;
  });
});
