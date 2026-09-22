import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SIGNATURE_TOLERANCE_SECONDS,
  computeSignature,
  parseWebhookEvent,
  verifySignature,
} from "../dist/index.js";

const secret = "whsec_test_secret";
const now = 1_790_000_000;
const body = JSON.stringify({
  id: "evt_1",
  type: "wallet_grade_changed",
  created_at: "2026-09-22T00:00:00Z",
  data: { address: "0xabc", old_grade: "B", new_grade: "A" },
});

const input = (overrides = {}) => ({
  secret,
  timestamp: now,
  body,
  signature: computeSignature(secret, now, body),
  nowSeconds: now,
  ...overrides,
});

test("a signature over the exact raw body verifies", () => {
  assert.equal(verifySignature(input()), true);
  assert.equal(verifySignature(input({ timestamp: String(now) })), true);
  assert.equal(verifySignature(input({ body: new TextEncoder().encode(body) })), true);
  assert.match(computeSignature(secret, now, body), /^v1=[0-9a-f]{64}$/);
});

test("a changed body, signature, secret or timestamp does not verify", () => {
  assert.equal(verifySignature(input({ body: body.replace('"A"', '"S"') })), false);
  assert.equal(verifySignature(input({ body: JSON.stringify(JSON.parse(body), null, 2) })), false);
  assert.equal(verifySignature(input({ signature: `v1=${"0".repeat(64)}` })), false);
  assert.equal(verifySignature(input({ secret: "whsec_other" })), false);
  assert.equal(verifySignature(input({ timestamp: now + 1, signature: computeSignature(secret, now, body) })), false);
  assert.equal(verifySignature(input({ timestamp: "not-a-number" })), false);
  assert.equal(verifySignature(input({ signature: "" })), false);
});

test("any one candidate in a rotation list verifies", () => {
  const good = computeSignature(secret, now, body);
  const stale = computeSignature("whsec_previous", now, body);
  assert.equal(verifySignature(input({ signature: `${stale},${good}` })), true);
  assert.equal(verifySignature(input({ signature: `${stale}` })), false);
});

test("the replay window is inclusive at the tolerance and fails one second past it", () => {
  assert.equal(SIGNATURE_TOLERANCE_SECONDS, 300);
  const at = (age) => input({ nowSeconds: now + age });
  assert.equal(verifySignature(at(300)), true);
  assert.equal(verifySignature(at(-300)), true);
  assert.equal(verifySignature(at(301)), false);
  assert.equal(verifySignature(at(-301)), false);
  assert.equal(verifySignature({ ...at(0), toleranceSeconds: 0 }), true);
  assert.equal(verifySignature({ ...at(1), toleranceSeconds: 0 }), false);
  assert.equal(verifySignature({ ...at(10), toleranceSeconds: 10 }), true);
  assert.equal(verifySignature(input({ nowSeconds: Number.NaN })), false);
});

test("receiver misconfiguration throws instead of disabling the check", () => {
  assert.throws(() => verifySignature(input({ secret: "" })), /non-empty signing secret/);
  for (const toleranceSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.throws(() => verifySignature(input({ toleranceSeconds })), /finite number of at least 0/);
  }
});

test("parseWebhookEvent returns the typed envelope", () => {
  const event = parseWebhookEvent(body);
  assert.equal(event.type, "wallet_grade_changed");
  assert.equal(event.data.new_grade, "A");
});
