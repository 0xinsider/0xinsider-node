import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_BASE_URL,
  OxinsiderApiClient,
  SANDBOX_BASE_URL,
  assertTrustedBaseUrl,
} from "../dist/index.js";
import { header, jsonResponse, listPage, mockFetch } from "./helpers.mjs";

const KEY = "oxi_sk_live_testkey";

test("a plain-http base URL on a non-loopback host is refused before any request", () => {
  const fetchImpl = mockFetch(() => jsonResponse(200, {}));
  for (const baseUrl of [
    "http://api.0xinsider.com",
    "http://example.com:8080",
    "http://localhost.example.com",
    "http://10.0.0.1",
  ]) {
    assert.throws(
      () => new OxinsiderApiClient({ apiKey: KEY, baseUrl, fetch: fetchImpl }),
      /Refusing to send the API key/,
      baseUrl,
    );
  }
  assert.throws(() => assertTrustedBaseUrl("ftp://api.0xinsider.com"), /Refusing to send the API key/);
  assert.throws(() => assertTrustedBaseUrl("not a url"), /not a valid URL/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("https anywhere and http on a loopback host are accepted", () => {
  for (const baseUrl of [
    DEFAULT_BASE_URL,
    SANDBOX_BASE_URL,
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://127.1.2.3",
    "http://[::1]:3000",
  ]) {
    assert.doesNotThrow(() => new OxinsiderApiClient({ apiKey: KEY, baseUrl }), baseUrl);
  }
});

test("the key is sent as a bearer header to the configured origin", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(200, listPage([])));
  const client = new OxinsiderApiClient({ apiKey: KEY, baseUrl: "http://localhost:9999", fetch: fetchImpl });
  await client.listLeaderboard({ limit: 1 });
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url.origin, "http://localhost:9999");
  assert.equal(url.pathname, "/api/v1/leaderboard");
  assert.equal(header(init, "authorization"), `Bearer ${KEY}`);
});

test("a bearer operation without a key fails locally in production, before fetch", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(200, {}));
  const client = new OxinsiderApiClient({ fetch: fetchImpl });
  await assert.rejects(client.listWhaleTrades({ limit: 1 }), /requires an API key/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("the sandbox keeps its /sandbox path, sends no credential, and refuses a live key", async () => {
  assert.throws(() => OxinsiderApiClient.sandbox({ apiKey: KEY }), /Refusing to send a live API key/);
  const fetchImpl = mockFetch(() =>
    jsonResponse(200, listPage([]), { "x-oxi-sandbox": "true" }),
  );
  const client = OxinsiderApiClient.sandbox({ fetch: fetchImpl });
  const board = await client.listLeaderboard({ limit: 5 });
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url.href, "https://0xinsider.com/sandbox/api/v1/leaderboard?limit=5");
  assert.equal(header(init, "authorization"), null);
  assert.equal(board.meta.sandbox, true);
});
