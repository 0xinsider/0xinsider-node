// Live calls against https://0xinsider.com/sandbox: no credential, example
// data only, never production data. Skipped unless OXINSIDER_SANDBOX_TESTS=1,
// so an offline `npm test` stays green; CI sets it on one leg.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BadRequestError,
  OxinsiderApiClient,
  RateLimitedError,
  streamFeed,
} from "../dist/index.js";

const skip = process.env.OXINSIDER_SANDBOX_TESTS !== "1" && "set OXINSIDER_SANDBOX_TESTS=1 to call the sandbox";
const sandbox = () => OxinsiderApiClient.sandbox({ timeoutMs: 30_000 });

test("the sandbox answers a list operation with a typed envelope and marks it", { skip }, async () => {
  const board = await sandbox().listLeaderboard({ limit: 5 });
  assert.equal(board.object, "list");
  assert.ok(Array.isArray(board.data));
  assert.equal(typeof board.has_more, "boolean");
  assert.equal(board.meta.sandbox, true);
  assert.equal(typeof board.meta.request_id, "string");
});

test("the sandbox answers a single resource and a batch read", { skip }, async () => {
  const client = sandbox();
  const trader = await client.getTrader("swisstony");
  assert.equal(trader.object, "trader");
  assert.equal(trader.meta.sandbox, true);
  const batch = await client.batchGetTraders(["swisstony", "0x0000000000000000000000000000000000000001"]);
  assert.ok(Array.isArray(batch.data));
  const health = await client.getHealth();
  assert.equal(typeof health.object, "string");
});

test("sandbox_status returns the documented error as its typed class", { skip }, async () => {
  await assert.rejects(
    sandbox().getTrader("swisstony", { query: { sandbox_status: 429 }, maxRetries: 0 }),
    (error) => {
      assert.ok(error instanceof RateLimitedError, String(error));
      assert.equal(error.status, 429);
      assert.ok(error.retryAfterSeconds > 0);
      return true;
    },
  );
});

test("the stream is not simulated: the sandbox answers it with its own 400", { skip }, async () => {
  const iterator = streamFeed(sandbox());
  await assert.rejects(iterator.next(), BadRequestError);
});
