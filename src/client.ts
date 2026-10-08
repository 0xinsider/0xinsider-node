/**
 * Standalone 0xinsider API V1 client.
 *
 * Ported from the app's original repo-owned client (`web/src/lib/api-client`,
 * removed in #9060; this package is now the sole client implementation). The
 * `API_CLIENT_OPERATIONS` table below IS the contract surface:
 * `scripts/check-sdk-openapi-drift.mjs` asserts it equals the set of operations
 * with a `200` response in `web/public/api/v1/openapi.json`, so this package
 * cannot silently diverge from the spec. That enforcement used to be a vitest
 * suite, which the repository does not run -- the table shipped three
 * operations short before #9687 replaced it with the runnable script, and
 * #11894 deleted the suite.
 *
 * Differences from the retired app client (intentional):
 *  - No `@/lib/api-contracts` import; the operation table is inlined so the
 *    package has zero workspace coupling.
 *  - Errors throw the typed subclass hierarchy in `errors.ts` (the app client
 *    threw a single `OxinsiderApiError`).
 *  - Extra typed convenience methods for list/candle/webhook-event/stream
 *    surfaces and a typed `Grade` enum.
 */

import { createHash } from "node:crypto";

import { errorFromResponse, ExportIntegrityError, OxinsiderApiError,
  InvalidResponseError,
  RequestTimeoutError,
  ResponseBodyReadError,
} from "./errors.js";
import {
  RETRY_AFTER_CEILING_MS,
  retryAfterSeconds,
  sleepUnlessAborted,
} from "./retry.js";
import type {
  OperationBody,
  OperationData,
  OperationPath,
  OperationQuery,
  OperationResponse,
  ResponseMeta,
  TraderExportArtifactManifest,
} from "./schema.js";

/**
 * The envelope `meta` as THIS client hands it to a caller: everything the
 * contract declares (`ResponseMeta`), plus `etag`.
 *
 * `etag` is a client-side addition, not a contract field. The server sends it
 * as an `ETag` response HEADER and never in the body, so the OpenAPI document
 * is right not to declare it; this client lifts it into `meta` so a caller can
 * echo it on a conditional re-request without reaching for the raw headers
 * (#14278 -- the hand-written `ResponseMeta` carried `etag` inline, which read
 * as though the server sent it).
 */
export type ClientResponseMeta = ResponseMeta & {
  /** Lifted from the `ETag` response header by this client. */
  etag?: string;
  /**
   * `true` when the response carried `X-Oxi-Sandbox: true`, which every
   * response of the sandbox server does and no production response does.
   * Lifted from the header by this client (#16138); absent otherwise.
   */
  sandbox?: true;
  /**
   * HTTP status of the success response, set by this client (#16137).
   * `201` on `registerAgent`, `202` on a `submitTraderExport` that queued a
   * new job or `createWebhookVerificationAttempt` admission, `200` on reads.
   */
  status?: number;
  /** Unknown query names reported by the server in compatibility mode. */
  queryIgnored?: string;
  /** Normalized query names and values the server actually applied. */
  effectiveQuery?: string;
};


export type ApiClientMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Whether an operation requires the `oxi_sk_*` Bearer key. */
export type AuthMode = "none" | "bearer";

/**
 * How an operation carries its success body, which decides the method that
 * can read it (#16137). Before this, every row was assumed to answer the
 * JSON envelope, so `call()` parsed Markdown as JSON and then rejected it as
 * a bad 200.
 *
 *  - `envelope` (the default, and every row that omits `kind`): a JSON
 *    `{ object, data, meta }` body -> `call()` and `list()`.
 *  - `text`: a `text/*` body -> `text()`. The two `context.md` reads.
 *  - `jsonrpc`: a JSON-RPC 2.0 response, or an empty `202` for a
 *    notification -> `mcp()`. `POST /api/v1/mcp`.
 *  - `sse`: an open-ended `text/event-stream` -> `streamFeed()` and the
 *    other consumers in `stream.ts`. Buffering one with `call()` or `text()`
 *    would never return, so both refuse it.
 *
 * `scripts/check-sdk-openapi-drift.mjs` derives the same kind from each
 * operation's documented success media type and schema and fails on a row
 * that disagrees, so a route that changes shape cannot keep a stale kind.
 */
export type ResponseKind = "envelope" | "text" | "jsonrpc" | "sse";

export interface ApiClientOperation {
  readonly method: ApiClientMethod;
  readonly path: string;
  readonly operationId: string;
  readonly auth: AuthMode;
  /** How the success body is carried; absent means `"envelope"`. */
  readonly kind?: ResponseKind;
}

/**
 * A published operation whose success is a REDIRECT, so it has no success
 * body and cannot go through `call()` (#16137). Declared here rather than
 * omitted in silence: the drift check requires every redirect-only spec
 * operation to appear in `REDIRECT_OPERATIONS` with the method that follows
 * it, so "the SDK cannot do this" is never the same as "nobody noticed".
 */
export interface ApiRedirectOperation {
  readonly method: ApiClientMethod;
  readonly path: string;
  readonly operationId: string;
  readonly auth: AuthMode;
  /** The documented redirect status. */
  readonly status: number;
  /** How a caller reaches it through this package. */
  readonly handledBy: string;
}

/** A published operation this client deliberately does not wrap. */
export interface ApiUnsupportedOperation {
  readonly method: ApiClientMethod;
  readonly path: string;
  readonly operationId: string;
  /** Why there is no method, and what to use instead. */
  readonly reason: string;
}

/**
 * The full V1 operation table. One row per OpenAPI operation with a
 * documented 2xx, which since #16137 includes the `201`-only
 * `registerAgent`; `kind` says which method reads its body. Kept in lockstep
 * with `web/public/api/v1/openapi.json` by
 * `scripts/check-sdk-openapi-drift.mjs`, which also checks every row's kind
 * against the spec. Do not add a row without a matching spec operation, and
 * do not remove a spec operation without removing its row. A redirect-only
 * operation belongs in `REDIRECT_OPERATIONS` below, not here.
 */
export const API_CLIENT_OPERATIONS = [
  {
    method: "GET",
    path: "/api/v1/combos/fills",
    operationId: "listComboFills",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/combos/summary",
    operationId: "getCombosSummary",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/combos/{condition_id}",
    operationId: "getCombo",
    auth: "bearer",
  },
  { method: "POST", path: "/api/v1/datasets/whale-trades", operationId: "submitWhaleDataset", auth: "bearer" },
  { method: "GET", path: "/api/v1/datasets/whale-trades/{job_id}", operationId: "getWhaleDatasetStatus", auth: "bearer" },
  { method: "POST", path: "/api/v1/datasets/whale-trades/{job_id}/cancel", operationId: "cancelWhaleDataset", auth: "bearer" },

  { method: "GET", path: "/api/v1/me", operationId: "getAccountIdentity", auth: "bearer" },
  {
    method: "GET",
    path: "/api/v1",
    operationId: "getApiDiscovery",
    auth: "none",
  },
  {
    method: "GET",
    path: "/api/v1/trader/{address}",
    operationId: "getTrader",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/traders/batch",
    operationId: "batchGetTraders",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/trader/{address}/position-timeline",
    operationId: "getPositionTimeline",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/traders/{trader}/position-timeline",
    operationId: "getPositionTimelineById",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/positions",
    operationId: "listPositions",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/large-positions",
    operationId: "listLargePositions",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/trader/{address}/pnl",
    operationId: "getTraderPnl",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/trader/{address}/categories",
    operationId: "getTraderCategoryRecords",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/trader/{address}/grade-at",
    operationId: "getTraderGradeAt",
    auth: "bearer",
  },
  // Pre-existing op-table drift (surfaced by test/drift.test.ts, #6915): these
  // 200-returning openapi operations were never mirrored into the client table.
  // Added so the table stays contract-complete against the checked-in spec. All
  // inherit the global `bearerAuth` security (no per-op `security: []` override,
  // and none are in the backend public-path allowlist), so auth is "bearer".
  // The drift check intentionally excludes the redirect-only routes (openapi-spec
  // redirect + export/download, no 200 response), so they are NOT added here.
  {
    method: "GET",
    path: "/api/v1/trader/{address}/context",
    operationId: "getTraderContext",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/trader/{address}/context.md",
    operationId: "getTraderContextMarkdown",
    auth: "bearer",
    kind: "text",
  },
  {
    method: "POST",
    path: "/api/v1/trader/{address}/export",
    operationId: "submitTraderExport",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/trader/{address}/export/status",
    operationId: "getTraderExportStatus",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/trader/{address}/export/cancel",
    operationId: "cancelTraderExport",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/leaderboard/trending",
    operationId: "listTrendingWallets",
    auth: "bearer",
  },
  // Pre-existing gap, fixed here (#7209): the route has shipped in openapi.json,
  // llms-full.txt, agents.md, and the discovery doc, but never in the SDK table --
  // so `drift.test.ts` was RED on main and SDK users had no typed method for it.
  {
    method: "GET",
    path: "/api/v1/sports/pre-game-sides",
    operationId: "listPreGameSides",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/sports/pre-game-side-observations",
    operationId: "listPreGameSideObservations",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/sports-edge-signals",
    operationId: "listSportsEdgeSignals",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/sports-edge-observations",
    operationId: "listSportsEdgeObservations",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/games",
    operationId: "listGames",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/games/{event_slug}",
    operationId: "getGame",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/large-trades",
    operationId: "listLargeTrades",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/large-trades/history",
    operationId: "listLargeTradeHistory",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/large-trades/{id}/counterparties/executions",
    operationId: "listLargeTradeCounterpartyExecutions",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/large-trades/{id}/counterparties/executions/{execution_id}/makers",
    operationId: "listLargeTradeCounterpartyMakers",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/large-trades/{id}",
    operationId: "getLargeTrade",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/whale-trades",
    operationId: "listWhaleTrades",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/whale-trades/history",
    operationId: "listWhaleTradeHistory",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/whale-trades/{id}/counterparties/executions",
    operationId: "listWhaleTradeCounterpartyExecutions",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/whale-trades/{id}/counterparties/executions/{execution_id}/makers",
    operationId: "listWhaleTradeCounterpartyMakers",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/content/search",
    operationId: "searchContent",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/whale-trades/{id}",
    operationId: "getWhaleTrade",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/leaderboard",
    operationId: "listLeaderboard",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/markets/search",
    operationId: "searchMarkets",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/markets/explore",
    operationId: "exploreMarkets",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/markets/smart-money-flows",
    operationId: "listSmartMoneyFlows",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/markets/sharp-money-flows",
    operationId: "listSharpMoneyFlows",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/coverage",
    operationId: "getCoverage",
    auth: "none",
  },
  {
    method: "GET",
    path: "/api/v1/platforms",
    operationId: "getPlatforms",
    auth: "none",
  },
  {
    method: "GET",
    path: "/api/v1/market/{condition_id}/holders",
    operationId: "getMarketHolders",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/market/{condition_id}/flow",
    operationId: "getMarketFlow",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/market/{condition_id}/intel",
    operationId: "getMarketIntel",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/markets/flow/batch",
    operationId: "batchGetMarketFlow",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/markets/intel/batch",
    operationId: "batchGetMarketIntel",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/market/{condition_id}/snapshot",
    operationId: "getMarketSnapshot",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/market/{condition_id}/context.md",
    operationId: "getMarketContextMarkdown",
    auth: "bearer",
    kind: "text",
  },
  {
    method: "GET",
    path: "/api/v1/market/{condition_id}/candles",
    operationId: "getMarketCandles",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/suspicious-trades",
    operationId: "listSuspiciousTrades",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/suspicious-trades/{id}",
    operationId: "getSuspiciousTrade",
    auth: "bearer",
  },
  // Deprecated aliases (#16301). Both paths stay live with no retirement
  // date; responses carry Deprecation and a Link rel="successor-version".
  // `/api/v1/insider-radar/{id}` also keeps answering `object: "radar_flag"`,
  // so these entries are what an existing integration must keep exercising.
  {
    method: "GET",
    path: "/api/v1/insider-radar",
    operationId: "listInsiderRadar",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/insider-radar/{id}",
    operationId: "getInsiderRadarFlag",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/events/feed/since",
    operationId: "getEventReplaySince",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/stream",
    operationId: "getStream",
    auth: "bearer",
    kind: "sse",
  },
  {
    method: "GET",
    path: "/api/v1/webhooks",
    operationId: "listWebhooks",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/webhooks",
    operationId: "createWebhook",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/webhooks/{id}",
    operationId: "getWebhook",
    auth: "bearer",
  },
  {
    method: "PATCH",
    path: "/api/v1/webhooks/{id}",
    operationId: "updateWebhook",
    auth: "bearer",
  },
  {
    method: "DELETE",
    path: "/api/v1/webhooks/{id}",
    operationId: "deleteWebhook",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/webhooks/{id}/verify",
    operationId: "verifyWebhook",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/webhooks/{id}/verification-attempts",
    operationId: "createWebhookVerificationAttempt",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/webhooks/{id}/verification-attempts/{attempt_id}",
    operationId: "getWebhookVerificationAttempt",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/webhooks/{id}/rotate-secret",
    operationId: "rotateWebhookSecret",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/webhooks/{id}/rotate-secret/prepare",
    operationId: "prepareWebhookSecret",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/webhooks/{id}/rotate-secret/activate",
    operationId: "activateWebhookSecret",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/webhooks/{id}/rotate-secret/retire",
    operationId: "retireWebhookSecret",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/webhooks/events",
    operationId: "listWebhookEvents",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/webhooks/{id}/deliveries",
    operationId: "listWebhookDeliveries",
    auth: "bearer",
  },
  {
    method: "POST",
    path: "/api/v1/webhooks/{id}/deliveries/{delivery_id}/redeliver",
    operationId: "redeliverWebhookDelivery",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/health",
    operationId: "getHealth",
    auth: "none",
  },
  {
    method: "POST",
    path: "/api/v1/mcp",
    operationId: "createMcpJsonRpcResponse",
    auth: "bearer",
    kind: "jsonrpc",
  },
  {
    method: "GET",
    path: "/api/v1/reports",
    operationId: "getReports",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/reports/daily",
    operationId: "getDailyReportSnapshot",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/reports/weekly",
    operationId: "getWeeklyReportSnapshot",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/reports/monthly",
    operationId: "getMonthlyReportSnapshot",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/trader/{address}/export",
    operationId: "getTraderExportSnapshot",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/usage",
    operationId: "getUsage",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/pick-of-the-day",
    operationId: "getPickOfTheDay",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/pick-of-the-day/archive",
    operationId: "getPickOfTheDayArchive",
    auth: "bearer",
  },
  {
    method: "GET",
    path: "/api/v1/pick-of-the-day/ledger",
    operationId: "getPickOfTheDayLedger",
    // Keyless since #16459: the commitment ledger is published to be
    // republished, so a client can read it with no key configured.
    auth: "none",
  },
  {
    method: "GET",
    path: "/api/v1/pick-of-the-day/ledger/{pick_id}",
    operationId: "getPickOfTheDayLedgerEntry",
    auth: "none",
  },
  {
    method: "POST",
    path: "/api/v1/agents/register",
    operationId: "registerAgent",
    // `security: []` in the document: minting a sandbox key is the one write
    // that must work before a caller has any credential.
    auth: "none",
  },
] as const satisfies readonly ApiClientOperation[];

export type ApiOperationId =
  (typeof API_CLIENT_OPERATIONS)[number]["operationId"];

/** Operations whose success body is a `text/*` document; read with `text()`. */
export type TextOperationId = Extract<
  (typeof API_CLIENT_OPERATIONS)[number],
  { kind: "text" }
>["operationId"];

/** Operations whose success body is JSON-RPC 2.0; read with `mcp()`. */
export type JsonRpcOperationId = Extract<
  (typeof API_CLIENT_OPERATIONS)[number],
  { kind: "jsonrpc" }
>["operationId"];

/** Operations whose success body is an open SSE stream; read through `stream.ts`. */
export type SseOperationId = Extract<
  (typeof API_CLIENT_OPERATIONS)[number],
  { kind: "sse" }
>["operationId"];

/**
 * Published operations whose success is a redirect, with the method that
 * follows it (#16137). These have no 2xx body, so they are absent from
 * `API_CLIENT_OPERATIONS` and from the generated `schema.ts`;
 * `scripts/check-sdk-openapi-drift.mjs` requires every redirect-only spec
 * operation to be declared here, so one cannot go missing in silence again.
 */
export const REDIRECT_OPERATIONS = [

  {
    method: "GET",
    path: "/api/v1/trader/{address}/export/download",
    operationId: "downloadTraderExport",
    auth: "bearer",
    status: 302,
    handledBy:
      "getTraderExportDownloadUrl() resolves the Location; downloadTraderExport() then fetches the object with no Authorization header.",
  },
  { method: "GET", path: "/api/v1/datasets/whale-trades/{job_id}/download", operationId: "downloadWhaleDataset", auth: "bearer", status: 302, handledBy: "getWhaleDatasetDownloadUrl() resolves Location; fetch it without Authorization and verify the manifest hashes." },
  {
    method: "GET",
    path: "/api/v1/openapi.json",
    operationId: "redirectApiOpenapiSpec",
    auth: "none",
    status: 307,
    handledBy:
      "No method: the document is public and static, so fetch the URL directly and let your runtime follow the redirect. This package ships the same contract as generated types in schema.ts.",
  },
] as const satisfies readonly ApiRedirectOperation[];

/**
 * Published operations this client deliberately does not wrap, with the
 * reason. The drift check requires every remaining spec operation to be
 * accounted for here, so "unsupported" is always a stated decision.
 */
export const UNSUPPORTED_OPERATIONS = [
  {
    method: "GET",
    path: "/api/v1/mcp",
    operationId: "openMcpEventStream",
    reason:
      "The MCP endpoint offers no server-to-client stream: GET answers 405 by design, so a client that reconnects to it would loop (#16354). Post JSON-RPC with mcp() instead.",
  },
] as const satisfies readonly ApiUnsupportedOperation[];

/**
 * The writes the API replays under `Idempotency-Key`: a second request with
 * the same key and the same body returns the first result instead of
 * repeating the write. Source of truth: the operations declaring the
 * `Idempotency-Key` header parameter in `web/public/api/v1/openapi.json`,
 * pinned by `scripts/check-sdk-openapi-drift.mjs` (#16182). Only these are
 * retried on a transport or 5xx failure, and only when a key is set; a key on
 * any other operation is refused before the request, since the server would
 * ignore it and a retry could repeat the side effect (`verifyWebhook` sends
 * a challenge to your URL each time; `submitTraderExport` starts a job).
 */
export const IDEMPOTENT_WRITE_OPERATIONS = [
  "createWebhookVerificationAttempt",
  "createWebhook",
  "updateWebhook",
  "deleteWebhook",
  "rotateWebhookSecret",
  "prepareWebhookSecret",
  "activateWebhookSecret",
  "retireWebhookSecret",
  "redeliverWebhookDelivery",
] as const satisfies readonly ApiOperationId[];
export type IdempotentWriteOperationId =
  (typeof IDEMPOTENT_WRITE_OPERATIONS)[number];

/**
 * POST operations that read and never write (#16182): the batch lookups.
 * `POST /api/v1/traders/batch` and `POST /api/v1/markets/flow/batch` (with its
 * deprecated alias `POST /api/v1/markets/intel/batch`) resolve
 * their inputs and store nothing (`backend/src/api_v1/handlers/batch.rs`), so
 * a repeat cannot duplicate a side effect. Each attempt is one request
 * against the account's quota and one reservation of batch item units, which
 * is exactly what a retried GET costs, so they are retried like a GET. Every
 * other POST, PATCH or DELETE is retried only as a keyed write above.
 */
export const READ_ONLY_POST_OPERATIONS = [
  "batchGetTraders",
  "batchGetMarketFlow",
  "batchGetMarketIntel",
] as const satisfies readonly ApiOperationId[];

/**
 * Writes whose repeat converges on the state the first one reached, so a
 * retry cannot repeat a side effect and needs no `Idempotency-Key` (#16254).
 * `POST /api/v1/trader/{address}/export/cancel` moves a job at most once and
 * answers its current state every time: a second cancel of a cancelled job
 * returns it unchanged, and a cancel that lost the race to a finished file
 * returns the ready job. They are retried like a read; the API does not read
 * an `Idempotency-Key` on them, so one is refused like on any other write.
 */
export const CONVERGENT_WRITE_OPERATIONS = [
  "cancelWhaleDataset",
  "cancelTraderExport",
] as const satisfies readonly ApiOperationId[];

const idempotentWrites: ReadonlySet<string> = new Set(IDEMPOTENT_WRITE_OPERATIONS);
const readOnlyPosts: ReadonlySet<string> = new Set(READ_ONLY_POST_OPERATIONS);
const convergentWrites: ReadonlySet<string> = new Set(CONVERGENT_WRITE_OPERATIONS);

/**
 * How `call()` may repeat an operation that failed with 429, 502, 503, 504 or
 * a network error before any response (#16182):
 * - `"read"`: a GET, a read-only POST or a convergent write, repeated
 *   without conditions.
 * - `"keyed"`: an `IDEMPOTENT_WRITE_OPERATIONS` member, repeated only when
 *   the request carries an `Idempotency-Key`, with the same key and the same
 *   bytes on every attempt.
 * - `"never"`: any other write; the first failure is thrown.
 */
export type RetryEligibility = "read" | "keyed" | "never";

/** The retry class of an operation; see `RetryEligibility`. */
export function retryEligibility(
  operation: Pick<ApiClientOperation, "method" | "operationId">,
): RetryEligibility {
  if (
    operation.method === "GET" ||
    readOnlyPosts.has(operation.operationId) ||
    convergentWrites.has(operation.operationId)
  ) {
    return "read";
  }
  return idempotentWrites.has(operation.operationId) ? "keyed" : "never";
}

/**
 * Trader skill grade. Source of truth:
 * `components.schemas.Trader.properties.grade.enum` (S highest, F lowest).
 */
export const GRADES = ["S", "A", "B", "C", "D", "F"] as const;
export type Grade = (typeof GRADES)[number];

export type ApiQueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean)[];

export interface ApiRequestOptions {
  path?: Record<string, string | number>;
  query?: Record<string, ApiQueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Reject query names the operation does not publish before it runs. */
  strictQuery?: boolean;
  /** Cooperative cancellation; composed with the request deadline. */
  signal?: AbortSignal;
  /**
   * Per-call deadline in ms, overriding the client default; `null` disables
   * it for this call. The SSE stream (`streamFeed`) never has one. Retries
   * share this one deadline: no retry is started that cannot finish inside it.
   */
  timeoutMs?: number | null;
  /**
   * Retries for this call, overriding the client's `maxRetries` (#14281).
   * `0` sends exactly one request, which is the SDK's behaviour before retries.
   */
  maxRetries?: number;
  /**
   * Sent as the `Idempotency-Key` header. Accepted only on the
   * `IDEMPOTENT_WRITE_OPERATIONS` (`createWebhook`, `updateWebhook`,
   * `deleteWebhook`, `rotateWebhookSecret`, `prepareWebhookSecret`,
   * `activateWebhookSecret`, `retireWebhookSecret`, `redeliverWebhookDelivery`,
   * `createWebhookVerificationAttempt`),
   * where a replay with the same key and body returns the first result
   * instead of repeating the write; on any other operation `call()` throws
   * before sending, since the server would ignore the key (#16182). A keyed
   * write is the only non-read request the SDK retries, always with the
   * same key and the same body bytes. On `IdempotencyInProgressError`, or
   * when the outcome is unknown after a timeout or exhausted retries, send
   * the SAME key and body again to learn what happened; never mint a new key
   * for the same intent.
   * The effective header, after this option overrides `headers`, must be
   * nonempty after trimming and at most 255 UTF-8 bytes. Invalid keys throw
   * before fetch, even with `maxRetries: 0`; omit the key for one attempt.
   */
  idempotencyKey?: string;
}

export interface ApiClientOptions {
  /**
   * The server URL, one of the `servers` in the OpenAPI document:
   * `https://api.0xinsider.com` (the default) or
   * `https://0xinsider.com/sandbox`. A path on it is kept, so every operation
   * path (`/api/v1/...`) is appended after it (#16138: the path used to be
   * discarded, which sent a sandbox client to the live host). Trailing slashes
   * are trimmed, and a trailing `/api/v1` is removed once, since the operation
   * paths carry it.
   */
  baseUrl?: string;
  /**
   * The `oxi_sk_live_*` secret API key, or a sandbox key (`oxi_sk_test_*`)
   * when `sandbox` is set.
   */
  apiKey?: string;
  /**
   * Explicit sandbox mode (#16138). `baseUrl` defaults to
   * `SANDBOX_BASE_URL` (`https://0xinsider.com/sandbox`), every operation is
   * allowed without a key, since the sandbox needs no credential, and a live
   * key (`oxi_sk_live_*`) is refused by the constructor so it is never sent
   * there. A sandbox key from `POST /api/v1/agents/register` is optional and
   * is sent when given. `OxinsiderApiClient.sandbox()` builds one.
   */
  sandbox?: boolean;
  /** Override the global `fetch` (e.g. for testing or a proxy agent). */
  fetch?: typeof fetch;
  /**
   * Deadline for every request, connect to body, in ms. Default
   * `DEFAULT_TIMEOUT_MS` (15 000); `null` disables it. A request that misses
   * it rejects with `RequestTimeoutError`. Long-lived reads (`streamFeed`)
   * are not subject to it (#11115).
   */
  timeoutMs?: number | null;
  /**
   * How many times a failed idempotent request is retried (#14281). Default
   * `DEFAULT_MAX_RETRIES` (2); `0` disables retries.
   *
   * Retried: a GET, a read-only POST (`READ_ONLY_POST_OPERATIONS`), or an
   * `IDEMPOTENT_WRITE_OPERATIONS` write carrying an `Idempotency-Key`, that
   * failed with 408, 429, 502, 503, 504, or a network error before any
   * response (`retryEligibility`, #16182). A 408 is the server's own timeout
   * (`request_timeout`, #16146): it carries `Retry-After` on a GET, and a
   * keyed write replays safely. The wait is the
   * response's `Retry-After` (delta-seconds or an HTTP-date, `parseRetryAfter`)
   * plus up to 250 ms of jitter when present, otherwise a jittered exponential
   * backoff from 500 ms capped at 8 s. A `Retry-After` longer than
   * `RETRY_AFTER_CEILING_MS` (60 s) is not waited out; the error is thrown so
   * the caller can schedule it from `retryAfterSeconds` or `retryAt`. Never retried: 400, 401, 402, 403, 404, 409, 500, a write
   * without a key, this client's own timeout, or a caller abort. A retry never starts unless it
   * can finish inside `timeoutMs`, and a caller `AbortSignal` ends a backoff at
   * once.
   */
  maxRetries?: number;
}

/** Default production API base used when `baseUrl` is omitted. */
export const DEFAULT_BASE_URL = "https://api.0xinsider.com";

/**
 * The sandbox server, the second `servers` entry of the OpenAPI document: no
 * credential, no production data, every documented operation answered with
 * its example or a deterministic sample, `?sandbox_status=<code>` for a
 * documented error, and `X-Oxi-Sandbox: true` on every response. The two
 * Markdown documents answer `200 text/markdown` there and the export download
 * answers its `302` to a sample file the sandbox serves itself. `GET
 * /api/v1/stream` is the one operation it does not simulate and answers 400,
 * because an SSE stream is a live connection rather than a body.
 */
export const SANDBOX_BASE_URL = "https://0xinsider.com/sandbox";

/** A live secret key starts with this; the sandbox never needs one. */
const LIVE_KEY_PREFIX = "oxi_sk_live_";

/** Default per-request deadline; see `ApiClientOptions.timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Default retry budget; see `ApiClientOptions.maxRetries`. */
export const DEFAULT_MAX_RETRIES = 2;

/** Statuses a retry can fix: rate limited, or a gateway/availability failure. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_BACKOFF_MS = 8_000;
const RETRY_JITTER_MS = 250;

function assertRetryCount(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${source} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Milliseconds to wait before retry `attempt` (0-based), or `null` when the
 * server asked for a wait a retry loop should not hold. The ceiling check
 * runs on the server's number before jitter is added, so the value handed to
 * the timer is at most `RETRY_AFTER_CEILING_MS + RETRY_JITTER_MS`, far inside
 * the timer range (`MAX_TIMER_DELAY_MS`, `retry.ts`).
 */
function retryDelayMs(attempt: number, retryAfter: number | null): number | null {
  if (retryAfter !== null) {
    const requested = retryAfter * 1000;
    if (requested > RETRY_AFTER_CEILING_MS) return null;
    return requested + Math.random() * RETRY_JITTER_MS;
  }
  const ceiling = Math.min(RETRY_MAX_BACKOFF_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * The API key travels as a bearer header on every request, so the base URL
 * decides who receives it. Only `https:` is accepted, with `http:` allowed for
 * a loopback host (a local backend on `localhost` or `127.0.0.1`). Anything
 * else throws from the constructor, before any request is sent (#11115).
 */
export function assertTrustedBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`0xinsider API baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new Error(
    `Refusing to send the API key to ${url.origin}: baseUrl must use https: (http: is accepted only for a loopback host such as localhost or 127.0.0.1).`,
  );
}

/**
 * The server URL as this client stores it: origin plus path, trailing slashes
 * trimmed, and a trailing `/api/v1` removed once. Every operation path starts
 * with `/api/v1/`, so a base that already ends in it would double the prefix;
 * before #16138 such a base worked only because the path was discarded, and
 * this keeps it working.
 */
function normalizeBaseUrl(base: URL): string {
  const trimmed = base.toString().replace(/\/+$/, "");
  return trimmed.replace(/\/api\/v1$/, "");
}

/**
 * Join an `/api/v1/...` path onto the server URL, keeping the server's own
 * path (`/sandbox`) exactly once. REST (`buildUrl`) and the SSE stream
 * (`stream.ts`) both resolve through this, so the two cannot disagree about
 * where a path-bearing base points (#16138: `new URL("/api/v1/...", base)`
 * resolved against the origin and dropped `/sandbox`).
 */
export function resolveApiUrl(baseUrl: string, path: string): URL {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${baseUrl}${suffix}`);
}

/**
 * One signal that aborts on the deadline OR when the caller's signal aborts.
 * Uses native composition where available. The manual fallback removes both
 * source listeners when either source aborts.
 */
export function composeSignals(
  timeoutMs: number | null,
  caller?: AbortSignal,
): AbortSignal | undefined {
  return composeRequestSignal(timeoutMs, caller).signal;
}

interface RequestSignal {
  signal: AbortSignal | undefined;
  timeout?: AbortSignal;
  dispose?: () => void;
}

/** Keep cancellation live through body consumption, then release its listeners. */
function composeRequestSignal(
  timeoutMs: number | null,
  caller?: AbortSignal,
): RequestSignal {
  const timeout =
    timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
  if (!timeout) return { signal: caller };
  if (!caller) return { signal: timeout, timeout };
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([caller, timeout]), timeout };
  }
  const controller = new AbortController();
  const dispose = () => {
    caller.removeEventListener("abort", onCallerAbort);
    timeout.removeEventListener("abort", onTimeoutAbort);
  };
  const onCallerAbort = () => {
    dispose();
    controller.abort(caller.reason);
  };
  const onTimeoutAbort = () => {
    dispose();
    controller.abort(timeout.reason);
  };
  if (caller.aborted) {
    onCallerAbort();
  } else if (timeout.aborted) {
    onTimeoutAbort();
  } else {
    caller.addEventListener("abort", onCallerAbort, { once: true });
    timeout.addEventListener("abort", onTimeoutAbort, { once: true });
  }
  return { signal: controller.signal, timeout, dispose };
}

interface ExportVerification {
  jobId: number;
  expectedSha256: string;
  expectedSizeBytes: number;
}

const EXPORT_BODY_CLEANUP_TIMEOUT_MS = 2_000;

/** A failed transfer keeps its primary error and an observable cleanup cause. */
function exportCleanupCause(primary: unknown, cleanup: Error): unknown {
  if ((typeof primary === "object" && primary !== null) || typeof primary === "function") {
    try {
      const previousCause = (primary as { cause?: unknown }).cause;
      Object.defineProperty(primary, "cause", {
        configurable: true,
        writable: true,
        value: previousCause === undefined ? cleanup : new AggregateError(
          [previousCause, cleanup], "The original cause and export body cleanup failure",
        ),
      });
      return primary;
    } catch (annotationError: unknown) {
      return new AggregateError(
        [primary, cleanup, annotationError],
        "Export failed and its body cleanup diagnostic could not be attached",
        { cause: primary },
      );
    }
  }
  return new AggregateError(
    [primary, cleanup], "Export failed and its body cleanup also failed", { cause: primary },
  );
}

/** Observe cancellation without buffering an unbounded object-store error body. */
async function releaseExportBody(
  cancel: ((reason: unknown) => Promise<void>) | undefined,
  primary: unknown,
): Promise<unknown> {
  if (!cancel) return primary;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelled = Promise.resolve().then(() => cancel(primary)).then(
    () => undefined,
    (cause: unknown) => new Error("Export body cancellation failed", { cause }),
  );
  const deadline = new Promise<Error>((resolve) => {
    timer = setTimeout(() => resolve(new Error(
      `Export body cleanup did not settle within ${String(EXPORT_BODY_CLEANUP_TIMEOUT_MS)} ms; completion is unknown`,
    )), EXPORT_BODY_CLEANUP_TIMEOUT_MS);
  });
  try {
    const failure = await Promise.race([cancelled, deadline]);
    return failure ? exportCleanupCause(primary, failure) : primary;
  } finally {
    clearTimeout(timer);
  }
}

/** Own only the latest body/reader until the response is handed to the caller. */
class ExportBodyOwner {
  private cancel: ((reason: unknown) => Promise<void>) | undefined;

  response(response: Response): void {
    this.cancel = (reason) => response.body?.cancel(reason) ?? Promise.resolve();
  }

  reader(reader: ReadableStreamDefaultReader<Uint8Array>, dispose: () => void) {
    let finished = false;
    let cancellation: Promise<void> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      dispose();
      reader.releaseLock();
    };
    const cancel = (reason: unknown): Promise<void> => {
      if (cancellation) return cancellation;
      if (finished) return Promise.resolve();
      finished = true;
      dispose();
      cancellation = Promise.resolve().then(() => reader.cancel(reason)).finally(() => reader.releaseLock());
      return cancellation;
    };
    // Record the reader before hash or Response construction can throw.
    this.cancel = cancel;
    return { reader, finish, cancel, active: () => !finished };
  }

  transfer(): void {
    this.cancel = undefined;
  }

  release(primary: unknown): Promise<unknown> {
    const cancel = this.cancel;
    this.cancel = undefined;
    return releaseExportBody(cancel, primary);
  }
}

/** Hash decoded bytes with backpressure and finish the reader/listener owner. */
function managedExportBody(
  response: Response,
  owner: ExportBodyOwner,
  dispose: () => void,
  needsDisposal: boolean,
  verification?: ExportVerification,
): Response {
  if (!verification && !needsDisposal) return response;
  if (!response.body) {
    if (verification) throw new ExportIntegrityError(
      verification.jobId, verification.expectedSha256, null, verification.expectedSizeBytes, 0,
    );
    dispose();
    return response;
  }
  const lease = owner.reader(response.body.getReader(), dispose);
  const hasher = verification ? createHash("sha256") : undefined;
  let actualSizeBytes = 0;
  let consumerCancelled = false;
  const integrityFailure = (cause: unknown): unknown => verification
    ? new ExportIntegrityError(
      verification.jobId, verification.expectedSha256, null,
      verification.expectedSizeBytes, actualSizeBytes, cause,
    ) : cause;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await lease.reader.read();
      } catch (error: unknown) {
        if (consumerCancelled) return;
        // A rejected read is terminal; release the lock rather than cancel
        // an already errored stream and relabel its original failure.
        lease.finish();
        controller.error(integrityFailure(error));
        return;
      }
      if (consumerCancelled || !lease.active()) return;
      try {
        if (chunk.done) {
          lease.finish();
          const actualSha256 = hasher?.digest("hex");
          if (verification && (
            actualSizeBytes !== verification.expectedSizeBytes ||
            actualSha256 !== verification.expectedSha256
          )) {
            controller.error(new ExportIntegrityError(
              verification.jobId, verification.expectedSha256, actualSha256 ?? null,
              verification.expectedSizeBytes, actualSizeBytes,
            ));
          } else {
            controller.close();
          }
          return;
        }
        hasher?.update(chunk.value);
        actualSizeBytes += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      } catch (error: unknown) {
        const primary = await releaseExportBody(lease.cancel, error);
        if (!consumerCancelled) controller.error(integrityFailure(primary));
      }
    },
    cancel(reason: unknown) {
      consumerCancelled = true;
      return lease.cancel(reason);
    },
  });
  const result = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  owner.response(result);
  return result;
}

/** JSON-RPC methods `POST /api/v1/mcp` answers without a credential. */
function isKeylessMcpMethod(method: string): boolean {
  return (
    method === "initialize" ||
    method === "ping" ||
    method === "tools/list" ||
    method.startsWith("notifications/")
  );
}

function isTimeoutAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "TimeoutError"
  );
}

/** Standard single-resource envelope: `{ object, data, meta }`. */
export interface ApiEnvelope<T> {
  object: string;
  data: T;
  meta?: ClientResponseMeta;
}

/** Stripe-style list envelope: `{ object: "list", data, has_more, next_cursor, total?, meta }`. */
export interface ApiListEnvelope<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor?: string | null;
  total?: number | null;
  meta?: ClientResponseMeta;
  /**
   * When this body was computed, on endpoints that publish a freshness envelope
   * (`markets/explore` today). Absent elsewhere.
   *
   * Pair it with `fresh_for_seconds` to bound how long you reuse the body:
   * `fresh_for_seconds - age(computed_at)`. The remainder is deliberately not
   * pre-subtracted, because a cached body cannot carry a number that changes
   * while it sits in a cache. Both are excluded from the `ETag` validator, so a
   * body recomputed with identical data keeps its validator.
   */
  computed_at?: string;
  /** How long the body computed at `computed_at` is good for, in seconds. */
  fresh_for_seconds?: number;
}

export type CategorySkillStatus =
  "live" | "insufficient" | "stale" | "unknown" | "degraded";

export interface CategorySkillStatusCounts {
  live: number;
  insufficient: number;
  stale: number;
  unknown: number;
  degraded: number;
}

/** Query parameters accepted by {@link OxinsiderApiClient.listGames}. */
export type GamesListParams = OperationQuery["listGames"];

/** One game: both sides, its schedule, its provider status and its markets. */
export type { Game } from "./schema.js";

/** Query parameters of `GET /api/v1/sports/pre-game-sides` (#16310). */
export type PreGameSidesParams = OperationQuery["listPreGameSides"];

/** @deprecated Use {@link PreGameSidesParams} (#16310). */
export type SportsEdgeSignalsParams = PreGameSidesParams;

/** Observation cohorts exposed by `listPreGameSideObservations`. */
export type SportsEdgeObservationCohort =
  | "wider_holder"
  | "in_play"
  | "emerging_pile";

/** Source of the provider holder snapshot used to build an observation. */
export type SportsEdgeObservationProviderSource = "cached" | "live";

/** Why a sport's upcoming-board source is (un)available in the funnel report. */
export type SportsEdgeObservationBoardUpcomingStatus =
  | "unknown"
  | "not_configured"
  | "available"
  | "capacity_limited"
  | "source_unavailable"
  | "cold_unavailable"
  | "deadline_unavailable";

/** Scope attribution for an unavailable upcoming-board union. */
export type SportsEdgeObservationBoardUnavailableScope =
  | "category"
  | "nfl"
  | "cfb"
  | "nba"
  | "wnba"
  | "nhl"
  | "mls"
  | "valorant"
  | "league-of-legends"
  | "counter-strike-2"
  | "dota-2"
  | "registry"
  | "union"
  | "wave";

/** Truthful state of the cross-market directional read. */
export type SportsEdgeObservationDirectionalStatus =
  "available" | "unknown_ungrouped" | "unknown_stale" | "unavailable";

/**
 * Provider binary-column selector for observation markets: 0 selects
 * outcome_yes/token_id_yes; 1 selects outcome_no/token_id_no. Use piled_side,
 * not this index, for participant identity.
 */
export type SportsEdgeObservationOutcomeIndex = 0 | 1;

/** Closed grade vocabulary for the best holder grade on an observation. */
export type SportsEdgeObservationTopGrade = "S" | "A" | "B";

/** Canonical sports emitted by observation responses. */
export type SportsEdgeObservationSport =
  | "Basketball"
  | "Football"
  | "Baseball"
  | "Hockey"
  | "MMA"
  | "Boxing"
  | "Soccer"
  | "Cricket"
  | "Golf"
  | "Tennis"
  | "Esports"
  | "Racing"
  | "Table Tennis"
  | "Pickleball";

/**
 * Full list response, including the observation snapshot and accountable
 * funnel: the operation's own envelope (#16136). `degraded` is the
 * snapshot-wide verdict; fully accounted `capacity_limited` rows alone do
 * not set it.
 */
export type PreGameSideObservationsResponse =
  OperationEnvelope<"listPreGameSideObservations">;

/** @deprecated Use {@link PreGameSideObservationsResponse} (#16310). */
export type SportsEdgeObservationsResponse = PreGameSideObservationsResponse;

/** Query parameters of `GET /api/v1/sports/pre-game-side-observations` (#16310). */
export type PreGameSideObservationsParams = OperationQuery["listPreGameSideObservations"];

/** @deprecated Use {@link PreGameSideObservationsParams} (#16310). */
export type SportsEdgeObservationsParams = PreGameSideObservationsParams;

/** Public wallet facts associated with a recorded pick. */
export interface PickQualifyingExpert {
  address: string;
  name?: string | null;
  grade?: string | null;
  /** Category of the recorded wallet statistics. */
  canonical_category: string;
  /** Recorded profitability fraction, when available. */
  win_rate: number | null;
  /** Recorded resolved-market count, when available. */
  n_resolved: number | null;
  /** Recorded position value in USD. */
  position_usd: number;
  /** Recorded opposite-outcome position value in USD, when available. */
  opposite_position_usd?: number | null;
  /** Recorded statistics timestamp. */
  stats_computed_at: string;
}

/**
 * Tennis tour a competitor belongs to. Only `atp` and `wta` name a gender: the
 * ITF World Tennis Tour runs men's and women's events and the provider does not
 * say which, so `itf` means tennis with gender unknown.
 */
export type TennisTour = "atp" | "wta" | "itf";

/** Typed 304 result returned for a matching `If-None-Match` conditional GET. */
export interface ApiNotModifiedResponse {
  object: "not_modified";
  data: null;
  meta: {
    status: 304;
    etag?: string;
    request_id?: string;
    queryIgnored?: string;
    effectiveQuery?: string;
    [key: string]: unknown;
  };
}

export type ApiClientResponse<T> = ApiEnvelope<T> | ApiNotModifiedResponse;

// --- Operation-bound types (#16136) ---
//
// Every convenience method, and `call` / `list` given a literal operation id,
// derive their path, query, body and result from `sdk/src/schema.ts`, which
// `scripts/generate-sdk-types.mjs` writes from `openapi.json`. Nothing below
// restates a field the document declares: a spec change regenerates the
// schema and the drift gate fails until it does, so an editor type can no
// longer advertise a field the route does not serve.

/** `etag`, `sandbox` and `status`, lifted by this client onto whichever `meta` the operation declares. */
export type ClientMeta<M> = M & {
  /** Lifted from the `ETag` response header by this client. */
  etag?: string;
  /** `true` when the response carried `X-Oxi-Sandbox: true` (#16138). */
  sandbox?: true;
  /**
   * The HTTP status of the success response, set by this client (#16137).
   *
   * Not every operation answers `200`, and the difference is the answer:
   * `registerAgent` answers `201`, and `submitTraderExport` answers `202`
   * when it queued a new job and `200` when it returned one that already
   * existed. The envelope body is the same shape either way, so without this
   * a caller could not tell a fresh job from a replayed one.
   */
  status?: number;
};

/** Operations whose 200 is the JSON envelope (`object`, `data`, `meta`); the two text bodies and the JSON-RPC post are not. */
export type EnvelopeOperationId = {
  [K in ApiOperationId]: OperationResponse[K] extends {
    object: string;
    data: unknown;
    meta: unknown;
  }
    ? K
    : never;
}[ApiOperationId];

/** Envelope operations that page: `data` is an array and `has_more` is declared. */
export type ListOperationId = {
  [K in EnvelopeOperationId]: OperationResponse[K] extends {
    has_more: boolean;
    data: readonly unknown[];
  }
    ? K
    : never;
}[EnvelopeOperationId];

/** The operation's documented `meta` type. */
export type OperationMeta<K extends ApiOperationId> = OperationResponse[K] extends {
  meta: infer M;
}
  ? M
  : never;

/**
 * What a 200 resolves to: the operation's own envelope (`object` literal,
 * `data`, every top-level field such as `has_more` or a list's `totals`) with
 * its own `meta` type (`BatchResponseMeta` on a batch, `EventReplayMeta` on
 * the replay, `ResponseMeta` elsewhere) plus this client's lifted `etag` and
 * `sandbox`.
 */
export type OperationEnvelope<K extends EnvelopeOperationId> = Omit<
  OperationResponse[K],
  "meta"
> & { meta: ClientMeta<OperationMeta<K>> };

/** A `call()` result: the envelope, or the typed 304 when `If-None-Match` matched. */
export type OperationResult<K extends EnvelopeOperationId> =
  | OperationEnvelope<K>
  | ApiNotModifiedResponse;

/** One item of a list operation's `data`. */
export type OperationItem<K extends ListOperationId> =
  OperationData[K] extends readonly (infer I)[] ? I : never;

/**
 * `call()` options bound to one operation: `path` is required exactly when
 * the route has path parameters, `query` is the documented query, `body` is
 * required exactly when the operation declares a request body, and the
 * transport options (`signal`, `timeoutMs`, `maxRetries`, `headers`,
 * `idempotencyKey`) are the shared ones.
 */
export type OperationRequestOptions<K extends ApiOperationId> = Omit<
  ApiRequestOptions,
  "path" | "query" | "body"
> &
  (OperationPath[K] extends Record<string, never>
    ? { path?: OperationPath[K] }
    : { path: OperationPath[K] }) & { query?: OperationQuery[K] } & ([
    OperationBody[K],
  ] extends [never]
    ? { body?: never }
    : { body: OperationBody[K] });

/**
 * Whether operation `K` cannot be called without options: it has path
 * parameters or a request body (#16643). For a union of operations it is
 * `true` when any member needs them.
 */
export type OperationRequiresOptions<K extends ApiOperationId> = true extends (
  K extends ApiOperationId
    ? OperationPath[K] extends Record<string, never>
      ? [OperationBody[K]] extends [never]
        ? false
        : true
      : true
    : never
)
  ? true
  : false;

/** The operations that can be called with no options at all. */
export type OptionalInputOperationId = {
  [K in ApiOperationId]: OperationRequiresOptions<K> extends true ? never : K;
}[ApiOperationId];

/**
 * The options argument of a typed overload (#16643): required when the
 * operation has path parameters or a body, optional otherwise, so
 * `client.call("createWebhook")` and `client.list("listWebhookDeliveries")`
 * fail to compile instead of failing at the API.
 */
export type OperationOptionsArgs<K extends ApiOperationId, O> =
  OperationRequiresOptions<K> extends true ? [options: O] : [options?: O];

/**
 * The operation id a LOOSE overload accepts (#16643). A value typed as the
 * whole `ApiOperationId` union (an id chosen at runtime) passes; a literal
 * passes only when the operation needs no options, so a literal with a
 * mandatory path or body cannot fall through to the loose form without them.
 * A caller that names the result type explicitly (`call<T>(...)`) skips the
 * inference this relies on; the runtime still refuses a missing path
 * parameter before any request.
 */
export type RuntimeOperationId<I extends ApiOperationId> = I &
  (ApiOperationId extends I ? unknown : OptionalInputOperationId);

/** The transport options a convenience method forwards: everything but the parts it fills itself. */
export type ConvenienceOptions = Omit<ApiRequestOptions, "path" | "query" | "body">;

/** Per-transport knobs `request()` accepts; none of them are a caller's business. */
interface RequestTransport {
  /** Which responses end the retry loop as a success. Default: `ok` or `304`. */
  isSuccess?: (response: Response) => boolean;
  /** The `Accept` header. Default: `application/json`. */
  accept?: string;
  /** Passed to `fetch`; `"manual"` keeps a redirect for the caller to read. */
  redirect?: RequestRedirect;
}

/** Which method reads each kind of success body, named in the error that refuses the wrong one. */
const READER_FOR_KIND: Record<ResponseKind, string> = {
  envelope: "call() or list()",
  text: "text()",
  jsonrpc: "mcp()",
  sse: "streamFeed(), streamFeedResilient() or consumeStreamCheckpointed()",
};

// --- MCP JSON-RPC (#16137) ---

/** The MCP methods `POST /api/v1/mcp` accepts, from the operation's request body. */
export const MCP_METHODS = [
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
  "tools/call",
] as const;
export type McpMethod = (typeof MCP_METHODS)[number];

/**
 * One JSON-RPC 2.0 message for `POST /api/v1/mcp`. `jsonrpc` defaults to
 * `"2.0"`. Omit `id` for a notification, which answers an empty `202`.
 */
export interface McpJsonRpcRequest {
  jsonrpc?: "2.0";
  /** Echoed exactly in the response. Omit it on a notification. */
  id?: string | number | null;
  method: McpMethod;
  params?: Record<string, unknown>;
}

/** The JSON-RPC 2.0 response body, as the operation declares it. */
export type McpJsonRpcResponse = OperationResponse["createMcpJsonRpcResponse"];

/** Options for `mcp()`: the shared transport options plus the two MCP headers. */
export interface McpOptions extends ConvenienceOptions {
  /** Sent as `Mcp-Session-Id`; use the value a previous response returned. */
  sessionId?: string;
  /**
   * Sent as `MCP-Protocol-Version`. Omit it and the server serves
   * `2025-03-26`; an unsupported revision is a `400`.
   */
  protocolVersion?: string;
}

/** What `mcp()` returns: the JSON-RPC response, or the accepted notification. */
export interface McpResult {
  /** `200` for a JSON-RPC response, `202` for an accepted notification. */
  status: 200 | 202;
  /** The JSON-RPC body, or `null` for the empty `202` a notification receives. */
  response: McpJsonRpcResponse | null;
  /** `Mcp-Session-Id`, when the server issued or echoed one. */
  sessionId?: string;
}

function isMcpJsonRpcResponse(body: unknown): body is McpJsonRpcResponse {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as { jsonrpc?: unknown; id?: unknown };
  return (
    candidate.jsonrpc === "2.0" &&
    (typeof candidate.id === "string" ||
      typeof candidate.id === "number" ||
      candidate.id === null)
  );
}

// --- Export download (#16137) ---

/** The `downloadTraderExport` row of `REDIRECT_OPERATIONS`, as a request target. */
const exportDownloadOperation: ApiClientOperation = {
  method: REDIRECT_OPERATIONS[0].method,
  path: REDIRECT_OPERATIONS[0].path,
  operationId: REDIRECT_OPERATIONS[0].operationId,
  auth: REDIRECT_OPERATIONS[0].auth,
};

/** Where a finished export actually lives, from the `302`'s `Location`. */
export interface TraderExportDownloadTarget {
  /**
   * The presigned object URL. It authorizes itself, so treat it as a
   * credential: never log it and never share it.
   */
  url: string;
  /**
   * When the link stops working, read from the URL's own SigV4
   * `X-Amz-Date` and `X-Amz-Expires`. Absent when the URL does not carry
   * them. Links last at most one hour and cannot outlive artifact retention.
   */
  expiresAt?: string;
}

/** The manifest field used by `downloadTraderExport` when verification is enabled. */
export interface TraderExportDownloadIntegrity {
  algorithm: "sha256";
  expectedSha256: string;
  expectedSizeBytes: number;
}

/** The object response, with what its headers said about the file. */
export interface TraderExportDownload extends TraderExportDownloadTarget {
  /** Not buffered: read `response.body` as a stream. */
  response: Response;
  /** `Content-Length` of the object, or `null` when the store sent none. */
  contentLength: number | null;
  contentType: string | null;
  /** The filename from `Content-Disposition`, or `null`. */
  filename: string | null;
  /** The expected content checksum, or `null` when `verifyChecksum` was not requested. */
  integrity: TraderExportDownloadIntegrity | null;
}

export interface TraderExportDownloadOptions extends ConvenienceOptions {
  /**
   * A deadline in ms for the OBJECT fetch, which has none by default: an
   * export can be far larger than a REST read and the 15-second default
   * would cut it off mid-file. `timeoutMs` still bounds the redirect.
   */
  downloadTimeoutMs?: number | null;
  /** Fetch the owner-authorized manifest and verify the streamed content before it is consumed. */
  verifyChecksum?: boolean;
}

/**
 * Read a presigned URL's own expiry, and refuse a destination that would
 * downgrade the transport. The backend already validates the redirect
 * against its expected R2 origin; this is the client-side half, so a
 * redirect can never move a download onto plain `http:`.
 */
function presignedTarget(location: string): TraderExportDownloadTarget {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new InvalidResponseError(
      302,
      `The export download redirect is not an absolute URL: ${location}`,
      null,
    );
  }
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new InvalidResponseError(
      302,
      `Refusing to follow the export download redirect to ${url.origin}: it must use https: (http: is accepted only for a loopback host).`,
      null,
    );
  }
  const signedAt = url.searchParams.get("X-Amz-Date");
  const lifetime = url.searchParams.get("X-Amz-Expires");
  const expiresAt = presignExpiry(signedAt, lifetime);
  return { url: url.toString(), ...(expiresAt ? { expiresAt } : {}) };
}

/** `20260922T101500Z` plus `3600` seconds, as an ISO instant; `null` if either is unreadable. */
function presignExpiry(
  signedAt: string | null,
  lifetimeSeconds: string | null,
): string | null {
  if (!signedAt || !lifetimeSeconds) return null;
  const parsed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(signedAt);
  const seconds = Number(lifetimeSeconds);
  if (!parsed || !Number.isFinite(seconds)) return null;
  const [, year, month, day, hour, minute, second] = parsed;
  const signed = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return new Date(signed + seconds * 1000).toISOString();
}

/** The `filename="..."` of a `Content-Disposition`, or `null`. */
function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const quoted = /filename\*?=(?:UTF-8'')?"([^"]+)"/i.exec(disposition);
  const quotedFilename = quoted?.[1];
  if (quotedFilename !== undefined) return decodeURIComponent(quotedFilename);
  const bare = /filename\*?=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  const bareFilename = bare?.[1];
  return bareFilename === undefined ? null : decodeURIComponent(bareFilename.trim());
}

/** Shared paging params accepted by Stripe-style list endpoints. */
export interface ListParams {
  limit?: number;
  cursor?: string;
  [key: string]: ApiQueryValue;
}

/** `GET /api/v1/leaderboard` -> parameters -> strategy (`web/public/api/v1/openapi.json`). */
export const LEADERBOARD_STRATEGIES = [
  "accumulator",
  "algo_trader",
  "arbitrageur",
  "category_focused",
  "directional",
  "diversified",
  "event_driven",
  "high_activity",
  "market_maker",
  "mixed",
  "momentum",
  "scalper",
  "speculator",
  "swing_trader",
  "two_sided",
  "unclassified",
] as const;
export type LeaderboardStrategy = (typeof LEADERBOARD_STRATEGIES)[number];

/**
 * Query parameters for `GET /api/v1/leaderboard`, from the operation
 * (#16136). The board has no `min_grade`: it only holds S, A, and B traders,
 * and the backend drops an unknown query key instead of rejecting it
 * (#10642), which is why the type now refuses one.
 */
export type LeaderboardListParams = OperationQuery["listLeaderboard"];

/** Query parameters for `GET /api/v1/leaderboard/trending`. */
export type TrendingWalletsParams = OperationQuery["listTrendingWallets"];

/** Query parameters of the V1 large-trade list (#16304). */
export type LargeTradeListParams = OperationQuery["listLargeTrades"];

/** Query parameters of the V1 historical large-trade replay (#16304). */
export type LargeTradeHistoryParams = OperationQuery["listLargeTradeHistory"];

/** @deprecated Use {@link LargeTradeListParams} (#16304). */
export type WhaleTradeListParams = OperationQuery["listWhaleTrades"];

/** @deprecated Use {@link LargeTradeHistoryParams} (#16304). */
export type WhaleTradeHistoryParams = OperationQuery["listWhaleTradeHistory"];

/** Query parameters of `GET /api/v1/positions`. */
export type PositionsListParams = OperationQuery["listPositions"];

/** Query parameters of `GET /api/v1/combos/fills`. */
export type ComboFillsParams = OperationQuery["listComboFills"];

/** Query parameters of `GET /api/v1/large-positions`. */
export type LargePositionsListParams = OperationQuery["listLargePositions"];

/** Query parameters of the sharp-money flows read and its legacy alias. */
export type SharpMoneyFlowsParams = OperationQuery["listSharpMoneyFlows"];

/** Query parameters of `GET /api/v1/suspicious-trades`: `min_suspicion` and `severity`, not a grade. */
export type SuspiciousTradesListParams = OperationQuery["listSuspiciousTrades"];

/**
 * @deprecated Use `SuspiciousTradesListParams`; the Insider Radar spelling of
 * this contract was renamed to suspicious trades in #16301. The deprecated
 * `GET /api/v1/insider-radar` takes the same parameters, so this stays an
 * alias with no retirement date.
 */
export type InsiderRadarListParams = SuspiciousTradesListParams;

/** Query parameters of `GET /api/v1/markets/explore`. */
export type ExploreMarketsParams = OperationQuery["exploreMarkets"];

/**
 * Body-level `expand` values of `POST /api/v1/traders/batch`. The type is the
 * operation's own body (`OperationBody["batchGetTraders"]["expand"]`); the
 * const is the same list as a runtime value for a caller that iterates it.
 */
export const BATCH_TRADER_EXPANSIONS = [
  "strategy",
  "categories",
  "quant_metrics",
  "trust",
] as const satisfies readonly BatchTraderExpand[];
export type BatchTraderExpand = NonNullable<OperationBody["batchGetTraders"]["expand"]>[number];

/**
 * Options for `batchGetTraders`. The body is built from the positional
 * `traders` array and `expand`, so `body` is not accepted here.
 */
export interface BatchGetTradersOptions extends ConvenienceOptions {
  /** Shared expand flags applied to every trader item; sent as the body's `expand`. */
  expand?: OperationBody["batchGetTraders"]["expand"];
}

const operationsById = new Map<ApiOperationId, ApiClientOperation>(
  API_CLIENT_OPERATIONS.map((operation) => [operation.operationId, operation]),
);

export class OxinsiderApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly sandbox: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | null;
  private readonly maxRetries: number;

  /** Polymarket combo fills, live count, and one combo's observed details. */
  readonly combos = {
    /** Recent pages use next_cursor; ranked pages use next_offset. */
    fills: (params: ComboFillsParams = {}, options: ConvenienceOptions = {}) =>
      this.list("listComboFills", { ...options, query: params }),
    summary: (options: ConvenienceOptions = {}) => this.call("getCombosSummary", options),
    get: (
      conditionId: OperationPath["getCombo"]["condition_id"],
      options: ConvenienceOptions = {},
    ) => this.call("getCombo", { ...options, path: { condition_id: conditionId } }),
  };

  /**
   * A client for the sandbox server (#16138): `SANDBOX_BASE_URL`, no
   * credential needed, example data only, never production data. The same
   * as `new OxinsiderApiClient({ ...options, sandbox: true })`; pass a
   * sandbox key (`oxi_sk_test_*`) as `apiKey` to have it checked.
   *
   * @example
   * const sandbox = OxinsiderApiClient.sandbox();
   * const board = await sandbox.listLeaderboard({ limit: 5 }); // no key
   * board.meta?.sandbox; // true
   */
  static sandbox(
    options: Omit<ApiClientOptions, "sandbox"> = {},
  ): OxinsiderApiClient {
    return new OxinsiderApiClient({ ...options, sandbox: true });
  }

  constructor(options: ApiClientOptions = {}) {
    this.sandbox = options.sandbox === true;
    const base = assertTrustedBaseUrl(
      options.baseUrl ?? (this.sandbox ? SANDBOX_BASE_URL : DEFAULT_BASE_URL),
    );
    this.baseUrl = normalizeBaseUrl(base);
    if (this.sandbox && options.apiKey?.startsWith(LIVE_KEY_PREFIX)) {
      // The sandbox needs no credential and ignores a live key, so the only
      // effect of sending one is a secret on the wire for nothing.
      throw new Error(
        "Refusing to send a live API key (oxi_sk_live_*) to the sandbox: omit apiKey, or pass a sandbox key (oxi_sk_test_*) from POST /api/v1/agents/register.",
      );
    }
    this.apiKey = options.apiKey;
    this.timeoutMs =
      options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    this.maxRetries = assertRetryCount(
      options.maxRetries ?? DEFAULT_MAX_RETRIES,
      "maxRetries",
    );
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error(
        "No fetch implementation available. Pass `fetch` in OxinsiderApiClient options or run on Node 18+ / a fetch-capable runtime.",
      );
    }
    // Bind so a passed-through `globalThis.fetch` keeps its receiver.
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  /**
   * Execute an envelope operation by id. Throws the matching
   * `OxinsiderApiError` subclass on a non-2xx response, returns a typed
   * `not_modified` result for a 304, and otherwise returns the operation's
   * own `{ object, data, meta, ... }` envelope (#16136): `path` is required
   * exactly when the route has path parameters, `query` and `body` are the
   * documented ones, and `data` and `meta` are the operation's types.
   *
   * @example
   * const trader = await client.call("getTrader", { path: { address } });
   * if (trader.object === "trader") trader.data.grade; // typed
   */
  call<K extends EnvelopeOperationId>(
    operationId: K,
    ...options: OperationOptionsArgs<K, OperationRequestOptions<K>>
  ): Promise<OperationResult<K>>;
  /**
   * The untyped form, for an operation chosen at runtime or a caller that
   * asserts the shape itself with `T`: loose `path`, `query` and `body`, and
   * the generic `{ object, data, meta? }` envelope back. Every convenience
   * method uses the typed form above; reach for this one only when the
   * operation id is not a literal.
   */
  call<T = unknown, I extends ApiOperationId = ApiOperationId>(
    operationId: RuntimeOperationId<I>,
    options?: ApiRequestOptions,
  ): Promise<ApiClientResponse<T>>;
  // The implementation signature is what both overloads narrow; `unknown`
  // here is the widest return both can refine, not a shape a caller sees.
  async call(
    operationId: ApiOperationId,
    options: ApiRequestOptions = {},
  ): Promise<unknown> {
    const operation = this.resolveOperation(operationId, "envelope");
    return this.request(operation, options, async (response) => {
      if (response.status === 304) {
        return notModifiedResponse(response);
      }
      const envelope = await parseJson(response);
      if (isApiEnvelope<unknown>(envelope)) {
        const etag = response.headers.get("etag");
        const sandbox = response.headers.get("x-oxi-sandbox") === "true";
        const queryIgnored = response.headers.get("x-query-ignored");
        const effectiveQuery = response.headers.get("x-effective-query");
        // Only ADD to a meta the server actually sent. The contract makes
        // `meta` required on every envelope, so synthesizing one from `?? {}`
        // would hand a caller a `ResponseMeta` missing its required fields --
        // which is what the hand-written type hid before #14278. `status` is
        // always lifted (#16137): `201` and `202` are load-bearing on
        // `registerAgent` and `submitTraderExport`, and a caller cannot read
        // them off a body that looks identical to a 200.
        if (envelope.meta) {
          envelope.meta = {
            ...envelope.meta,
            status: response.status,
            ...(etag ? { etag } : {}),
            ...(sandbox ? { sandbox: true as const } : {}),
            ...(queryIgnored ? { queryIgnored } : {}),
            ...(effectiveQuery ? { effectiveQuery } : {}),
          };
        }
        return envelope;
      }
      throw new OxinsiderApiError(response.status, envelope);
    });
  }

  /**
   * Read a `text/*` operation's body as a string (#16137).
   *
   * `getTraderContextMarkdown` and `getMarketContextMarkdown` answer
   * `text/markdown`, which `call()` used to parse as JSON and then reject as
   * an invalid 200. Authentication, the request deadline, retries and the
   * typed error hierarchy are the same as `call()`; only the body differs.
   *
   * @example
   * const md = await client.text("getTraderContextMarkdown", { path: { address } });
   */
  text<K extends TextOperationId>(
    operationId: K,
    ...options: OperationOptionsArgs<K, OperationRequestOptions<K>>
  ): Promise<string>;
  /** The untyped form, for an operation id chosen at runtime. */
  text<I extends ApiOperationId = ApiOperationId>(
    operationId: RuntimeOperationId<I>,
    options?: ApiRequestOptions,
  ): Promise<string>;
  async text(
    operationId: ApiOperationId,
    options: ApiRequestOptions = {},
  ): Promise<string> {
    const operation = this.resolveOperation(operationId, "text");
    return this.request(
      operation,
      options,
      async (response) => readResponseText(response),
      { accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
    );
  }

  /**
   * Post one MCP JSON-RPC 2.0 message to `POST /api/v1/mcp` (#16137).
   *
   * The endpoint answers a JSON-RPC envelope, not the `{ object, data, meta }`
   * envelope every other operation uses, so `call()` refuses it. A request
   * (one carrying `id`) comes back as `status: 200` with `response` set; a
   * supported notification (no `id`) comes back as `status: 202` with
   * `response: null`, which is the empty body the server sends. A JSON-RPC
   * `error` member is a protocol-level failure and is RETURNED, not thrown:
   * only a non-2xx HTTP status throws, because an unknown tool is an answer
   * and a revoked credential is not.
   *
   * The request is never retried: `tools/call` can have an effect, and the
   * endpoint honours no `Idempotency-Key`.
   *
   * @example
   * const listed = await client.mcp({ method: "tools/list", id: 1 });
   * listed.response?.result;
   */
  async mcp(
    request: McpJsonRpcRequest,
    options: McpOptions = {},
  ): Promise<McpResult> {
    // `initialize`, `ping`, `tools/list` and the notifications need no
    // credential (`backend/src/mcp/mod.rs`); only `tools/call` does, so the
    // local credential check is per method (#16686). A configured key is
    // still sent on every method.
    const operation = this.resolveOperation(
      "createMcpJsonRpcResponse",
      "jsonrpc",
      !isKeylessMcpMethod(request.method),
    );
    const { sessionId, protocolVersion, ...transportOptions } = options;
    const headers: Record<string, string> = { ...options.headers };
    if (sessionId !== undefined) {
      headers["mcp-session-id"] = sessionId;
    }
    if (protocolVersion !== undefined) {
      headers["mcp-protocol-version"] = protocolVersion;
    }
    // Set after the spread: an explicit `jsonrpc: undefined` would otherwise
    // drop the field and the server would answer 400 (#16686).
    const body: McpJsonRpcRequest = { ...request, jsonrpc: "2.0" };
    return this.request(
      operation,
      { ...transportOptions, headers, body, maxRetries: 0 },
      async (response) => {
        const sessionId = response.headers.get("mcp-session-id");
        const result: McpResult = {
          status: response.status === 202 ? 202 : 200,
          response: null,
          ...(sessionId ? { sessionId } : {}),
        };
        if (response.status === 202) return result;
        const parsed = await parseJson(response);
        if (!isMcpJsonRpcResponse(parsed)) {
          throw new InvalidResponseError(
            response.status,
            "POST /api/v1/mcp returned a body that is not a JSON-RPC 2.0 response: expected an object with jsonrpc \"2.0\" and an id.",
            parsed,
          );
        }
        result.response = parsed;
        return result;
      },
    );
  }

  /**
   * Read the owner-authorized lifecycle and artifact manifest for one export
   * job. The manifest is immutable for the artifact; the download URL remains
   * temporary and is resolved separately.
   */
  /** Submit a bounded cross-market snapshot; repeated identical live requests reuse it. */
  submitWhaleDataset(body: OperationBody["submitWhaleDataset"], options: ConvenienceOptions = {}) {
    return this.call("submitWhaleDataset", { ...options, body });
  }

  getWhaleDatasetStatus(jobId: number, options: ConvenienceOptions = {}) {
    return this.call("getWhaleDatasetStatus", { ...options, path: { job_id: jobId } });
  }

  cancelWhaleDataset(jobId: number, options: ConvenienceOptions = {}) {
    return this.call("cancelWhaleDataset", { ...options, path: { job_id: jobId } });
  }

  /** Resolve only the signed URL. Never log it or forward API credentials to storage. */
  async getWhaleDatasetDownloadUrl(jobId: number, options: ConvenienceOptions = {}): Promise<TraderExportDownloadTarget> {
    return this.request(
      { method: "GET", path: "/api/v1/datasets/whale-trades/{job_id}/download", operationId: "downloadWhaleDataset", auth: "bearer" },
      { ...options, path: { job_id: jobId } },
      async (response) => {
        const location = response.headers.get("location");
        if (!location) throw new InvalidResponseError(response.status, "Dataset redirect has no readable Location; use a server runtime.", null);
        return presignedTarget(location);
      },
      { isSuccess: (response) => response.status === 302, redirect: "manual" },
    );
  }

  /** Stream decoded NDJSON, validating its manifest hash when the body finishes. */
  async downloadWhaleDataset(jobId: number, options: TraderExportDownloadOptions = {}): Promise<TraderExportDownload> {
    const { downloadTimeoutMs, verifyChecksum = true, ...requestOptions } = options;
    const status = await this.getWhaleDatasetStatus(jobId, requestOptions);
    if (isApiNotModifiedResponse(status) || status.data.status !== "ready" || !status.data.artifact?.manifest) {
      throw new InvalidResponseError(200, "Dataset has no ready manifest; follow next_action on the status resource.", status);
    }
    const manifest = status.data.artifact.manifest;
    const target = await this.getWhaleDatasetDownloadUrl(jobId, requestOptions);
    return this.downloadExportObject(target, {
      ...(downloadTimeoutMs === undefined ? {} : { downloadTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, verifyChecksum ? {
      jobId, expectedSha256: manifest.content_sha256, expectedSizeBytes: manifest.content_size_bytes,
    } : undefined, (status) => new InvalidResponseError(
      status, "Dataset signed URL failed; request a fresh download URL.", null,
    ));
  }

  getTraderExportStatus(
    address: OperationPath["getTraderExportStatus"]["address"],
    jobId: OperationQuery["getTraderExportStatus"]["job_id"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("getTraderExportStatus", {
      ...options,
      path: { address },
      query: { job_id: jobId },
    });
  }

  /**
   * Resolve the presigned object URL behind `GET /api/v1/trader/{address}/export/download`
   * without downloading anything (#16137).
   *
   * The route answers `302` with a `Location`, which `call()` treats as an
   * error. This reads the redirect target and stops there, so a caller can
   * hand the URL to a download manager or a browser. The returned URL is a
   * bearer credential in itself: anyone holding it can read the file until it
   * expires, so do not log it.
   *
   * Browser caveat: `fetch` with `redirect: "manual"` yields an opaque
   * redirect whose `Location` no script can read. The method says so rather
   * than guessing a URL; run the download from a server runtime.
   */
  async getTraderExportDownloadUrl(
    address: OperationPath["getTraderExportStatus"]["address"],
    jobId: OperationQuery["getTraderExportStatus"]["job_id"],
    options: ConvenienceOptions = {},
  ): Promise<TraderExportDownloadTarget> {
    const operation = exportDownloadOperation;
    if (!this.apiKey && !this.sandbox) {
      throw new Error("downloadTraderExport requires an API key (oxi_sk_*)");
    }
    return this.request(
      operation,
      { ...options, path: { address }, query: { job_id: jobId } },
      async (response) => {
        if (response.type === "opaqueredirect" || response.status === 0) {
          throw new InvalidResponseError(
            302,
            "This runtime hides redirect targets: fetch with redirect: \"manual\" returned an opaque redirect, so the presigned download URL cannot be read. Run the export download from a server runtime (Node 18+, Deno, Bun, a Worker).",
            null,
          );
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new InvalidResponseError(
            response.status,
            "GET /api/v1/trader/{address}/export/download answered a redirect with no Location header.",
            null,
          );
        }
        return presignedTarget(location);
      },
      {
        // The 302 IS the success here, so it must not enter the error path.
        isSuccess: (response) =>
          response.status === 302 || response.type === "opaqueredirect",
        redirect: "manual",
      },
    );
  }

  /**
   * Download a finished export (#16137): resolve the `302`, then fetch the
   * object store directly.
   *
   * The second request carries NO headers at all, so the live API key never
   * reaches the object store; the presigned URL is its own credential. The
   * body is not buffered -- read `response.body` as a stream and write it
   * where it belongs.
   *
   * There is no default deadline on the object fetch, like the lifetime of
   * an established `streamFeed`: a multi-gigabyte export would fail the
   * 15-second REST default halfway through. Pass `signal` to cancel it, or `downloadTimeoutMs` for
   * a deadline of your own. `timeoutMs` still bounds the redirect request.
   *
   * @example
   * const { response, filename } = await client.downloadTraderExport(address, jobId);
   * await pipeline(Readable.fromWeb(response.body), createWriteStream(filename ?? "export.json"));
   */
  async downloadTraderExport(
    address: OperationPath["getTraderExportStatus"]["address"],
    jobId: OperationQuery["getTraderExportStatus"]["job_id"],
    options: TraderExportDownloadOptions = {},
  ): Promise<TraderExportDownload> {
    const {
      verifyChecksum = false,
      downloadTimeoutMs,
      ...requestOptions
    } = options;
    let manifest: TraderExportArtifactManifest | null = null;
    if (verifyChecksum) {
      const status = await this.getTraderExportStatus(
        address,
        jobId,
        requestOptions,
      );
      if (isApiNotModifiedResponse(status)) {
        throw new InvalidResponseError(
          304,
          `Export job ${String(jobId)} status was not modified, so its manifest could not be verified. Omit If-None-Match when verifyChecksum is enabled.`,
          status,
        );
      }
      if (status.data.status !== "ready" || !status.data.artifact?.manifest) {
        throw new InvalidResponseError(
          200,
          `Export job ${String(jobId)} did not return a ready artifact manifest, so verifyChecksum cannot verify the download. Wait for status=ready or request a fresh export.`,
          status,
        );
      }
      manifest = status.data.artifact.manifest;
    }
    const target = await this.getTraderExportDownloadUrl(
      address,
      jobId,
      requestOptions,
    );
    return this.downloadExportObject(target, {
      ...(downloadTimeoutMs === undefined ? {} : { downloadTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, manifest ? {
      jobId, expectedSha256: manifest.content_sha256, expectedSizeBytes: manifest.content_size_bytes,
    } : undefined, (status) => new InvalidResponseError(
      status,
      `The presigned export URL answered ${status}. Links last at most one hour and cannot outlive artifact retention. Request a fresh link with getTraderExportDownloadUrl; if the job is expired, submit a new export.`,
      null,
    ));
  }

  private async downloadExportObject(
    target: TraderExportDownloadTarget,
    options: TraderExportDownloadOptions,
    verification: ExportVerification | undefined,
    statusError: (status: number) => InvalidResponseError,
  ): Promise<TraderExportDownload> {
    const signal = composeRequestSignal(options.downloadTimeoutMs ?? null, options.signal);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      signal.dispose?.();
    };
    const owner = new ExportBodyOwner();
    try {
      // A signed object URL authorizes itself; never forward API headers.
      let response = await this.fetchImpl(target.url, {
        method: "GET",
        ...(signal.signal === undefined ? {} : { signal: signal.signal }),
      });
      owner.response(response);
      if (!response.ok) throw statusError(response.status);
      response = managedExportBody(response, owner, dispose, signal.dispose !== undefined, verification);
      const contentLength = response.headers.get("content-length");
      const result: TraderExportDownload = {
        ...target,
        response,
        contentLength: contentLength === null ? null : Number.parseInt(contentLength, 10),
        contentType: response.headers.get("content-type"),
        filename: filenameFromDisposition(response.headers.get("content-disposition")),
        integrity: verification ? {
          algorithm: "sha256", expectedSha256: verification.expectedSha256,
          expectedSizeBytes: verification.expectedSizeBytes,
        } : null,
      };
      owner.transfer();
      return result;
    } catch (error: unknown) {
      try {
        throw await owner.release(error);
      } finally {
        dispose();
      }
    }
  }

  /**
   * Look up an operation and refuse it when the caller reached for the wrong
   * reader (#16137): `call()` on a Markdown route used to fail as a bad 200.
   */
  private resolveOperation(
    operationId: ApiOperationId,
    expected: ResponseKind,
    requireCredential = true,
  ): ApiClientOperation {
    const operation = operationsById.get(operationId);
    if (!operation) {
      throw new Error(`Unknown 0xinsider API operation: ${operationId}`);
    }
    const kind = operation.kind ?? "envelope";
    if (kind !== expected) {
      throw new Error(
        `${operationId} answers a "${kind}" body, not "${expected}": use ${READER_FOR_KIND[kind]}.`,
      );
    }
    // The sandbox answers every operation without a credential; production
    // does not, and the local check saves a round trip that can only be 401.
    if (requireCredential && operation.auth === "bearer" && !this.apiKey && !this.sandbox) {
      throw new Error(`${operationId} requires an API key (oxi_sk_*)`);
    }
    return operation;
  }

  /**
   * One request pipeline for every transport: URL and headers, the retry
   * policy, one deadline shared by every attempt, the typed error hierarchy,
   * and cancellation held live through body consumption. `consume` runs
   * inside that window, so a slow body is still covered by the deadline and
   * by the caller's `signal`.
   */
  private async request<T>(
    operation: ApiClientOperation,
    options: ApiRequestOptions,
    consume: (response: Response) => Promise<T>,
    transport: RequestTransport = {},
  ): Promise<T> {
    const operationId = operation.operationId;
    const timeoutMs =
      options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs;
    const maxRetries =
      options.maxRetries === undefined
        ? this.maxRetries
        : assertRetryCount(options.maxRetries, "maxRetries");
    const url = this.buildUrl(operation, options);
    const headers = this.buildHeaders(operation, options, transport.accept);
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    const isSuccess =
      transport.isSuccess ??
      ((response: Response) => response.ok || response.status === 304);
    // A key the server does not read is a false promise of safety: the
    // request would be retried as though replayable while the route repeats
    // its effect (#16182). Refuse it here, before anything is sent.
    const eligibility = retryEligibility(operation);
    const keyed = headers.get("idempotency-key") !== null;
    if (keyed && eligibility !== "keyed") {
      throw new Error(
        `${operationId} does not honour Idempotency-Key; the API replays only ${IDEMPOTENT_WRITE_OPERATIONS.join(", ")}. Remove idempotencyKey: a retry of this request could repeat its side effect.`,
      );
    }
    // Replaying a write without a key could repeat it (a second webhook
    // endpoint, say), so only a read or a keyed write is retried (#14281).
    // `headers` and `body` are built once, above, so every attempt carries
    // the same key and the same bytes.
    const retryable =
      eligibility === "read" || (eligibility === "keyed" && keyed);
    // One deadline for every attempt: a retry that cannot finish before it is
    // not started, so the caller sees the real failure, not a timeout.
    const deadlineAt = timeoutMs === null ? null : Date.now() + timeoutMs;
    const retryDelayWithinBudget = (attempt: number, retryAfter: number | null) => {
      if (!retryable || attempt >= maxRetries) return null;
      const delay = retryDelayMs(attempt, retryAfter);
      if (delay === null) return null;
      if (deadlineAt !== null && Date.now() + delay >= deadlineAt) return null;
      return delay;
    };
    const requestSignal = composeRequestSignal(timeoutMs, options.signal);
    try {
      let response: Response;
      for (let attempt = 0; ; attempt += 1) {
        try {
          requestSignal.signal?.throwIfAborted();
          response = await this.fetchImpl(url, {
            method: operation.method,
            headers,
            ...(body === undefined ? {} : { body }),
            ...(requestSignal.signal === undefined ? {} : { signal: requestSignal.signal }),
            ...(transport.redirect ? { redirect: transport.redirect } : {}),
          });
        } catch (error: unknown) {
          // A timeout or caller abort is final; the handler below maps it.
          if (requestSignal.signal?.aborted || isTimeoutAbort(error)) throw error;
          const delay = retryDelayWithinBudget(attempt, null);
          if (delay === null) throw error;
          await sleepUnlessAborted(delay, requestSignal.signal);
          continue;
        }
        if (isSuccess(response)) break;
        const errorBody = await parseJson(response);
        const retryAfter = retryAfterSeconds(response);
        const delay = RETRYABLE_STATUSES.has(response.status)
          ? retryDelayWithinBudget(attempt, retryAfter)
          : null;
        if (delay === null) {
          throw errorFromResponse(response.status, errorBody, retryAfter, {
            requestId: response.headers.get("x-request-id"),
          });
        }
        await sleepUnlessAborted(delay, requestSignal.signal);
      }
      return await consume(response);
    } catch (error: unknown) {
      if (
        timeoutMs !== null &&
        requestSignal.timeout?.aborted &&
        requestSignal.signal?.aborted &&
        requestSignal.signal.reason === requestSignal.timeout.reason
      ) {
        // Composition preserves the first abort reason. Identity records which
        // source won even when both have fired before this catch runs (#19749).
        throw new RequestTimeoutError(operationId, timeoutMs);
      }
      if (requestSignal.signal?.aborted) {
        throw requestSignal.signal.reason;
      }
      throw error;
    } finally {
      requestSignal.dispose?.();
    }
  }

  /**
   * Execute a Stripe-style list operation and return its own list envelope
   * (`data`, `has_more`, `next_cursor`, and the route's extra fields such as
   * `facets` or `totals`). Use `paginate()` (in `pagination.ts`) to
   * auto-follow `next_cursor`.
   */
  list<K extends ListOperationId>(
    operationId: K,
    ...options: OperationOptionsArgs<K, OperationRequestOptions<K>>
  ): Promise<OperationEnvelope<K>>;
  /** The untyped form; see the second `call` signature. */
  list<T = unknown, I extends ApiOperationId = ApiOperationId>(
    operationId: RuntimeOperationId<I>,
    options?: ApiRequestOptions,
  ): Promise<ApiListEnvelope<T>>;
  async list(
    operationId: ApiOperationId,
    options: ApiRequestOptions = {},
  ): Promise<unknown> {
    const result = await this.call<unknown>(operationId, options);
    if (isNotModified(result)) {
      throw new OxinsiderApiError(
        304,
        "list() received a 304 not_modified; use call() if you send If-None-Match on a list endpoint",
      );
    }
    if (!isListEnvelope<unknown>(result)) {
      throw new InvalidResponseError(
        200,
        `Operation ${operationId} did not return a list envelope: expected object "list", an array data, a boolean has_more and a string or absent next_cursor`,
        result,
      );
    }
    return result;
  }

  // --- Typed convenience methods (key surfaces) ---
  //
  // Each takes the route's path parameters positionally, its documented
  // query as `params` (list reads) or `options.query` (single reads), and
  // the shared transport options: `signal`, `timeoutMs`, `maxRetries`,
  // `headers` (`If-None-Match` for a conditional read) and `idempotencyKey`
  // on a keyed write. The result is the operation's own envelope; no method
  // takes a type argument any more (#16136).

  getTrader(
    address: OperationPath["getTrader"]["address"],
    options: Omit<OperationRequestOptions<"getTrader">, "path"> = {},
  ) {
    return this.call("getTrader", { ...options, path: { address } });
  }

  getTraderPnl(
    address: OperationPath["getTraderPnl"]["address"],
    options: Omit<OperationRequestOptions<"getTraderPnl">, "path"> = {},
  ) {
    return this.call("getTraderPnl", { ...options, path: { address } });
  }

  /**
   * Fetch one wallet's win record per canonical category.
   *
   * Counts every settled market at any position size, so it can differ from
   * `category_strengths` on `getTrader`, which reads the floored calibration
   * sample. A category under `min_decided_for_win_rate` keeps its `wins` and
   * `decided` with `win_rate: null` and `status: "not_enough_data"`; a category
   * the wallet has no settled market in is absent, which means no record rather
   * than a 0% record. The `Esports` record carries `games`: the wallet's record
   * per esports title (`LoL`, `CS2`, `Dota 2`, ...) under the same rule, named
   * as the holder chips name them in `category_win_rate_game`. Pass
   * `params.category` to filter to one bucket; a filter that reaches Esports
   * returns its games too.
   */
  getTraderCategoryRecords(
    address: OperationPath["getTraderCategoryRecords"]["address"],
    params: OperationQuery["getTraderCategoryRecords"] = {},
    options: ConvenienceOptions = {},
  ) {
    return this.call("getTraderCategoryRecords", {
      ...options,
      path: { address },
      query: params,
    });
  }

  /** Read the grade proven visible at one past decision time. */
  getTraderGradeAt(
    address: OperationPath["getTraderGradeAt"]["address"],
    params: OperationQuery["getTraderGradeAt"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("getTraderGradeAt", {
      ...options,
      path: { address },
      query: params,
    });
  }

  /**
   * Resolve 1 to 25 traders in one request (`POST /api/v1/traders/batch`).
   *
   * `traders` is sent as the request body's `traders` array, the field the
   * route requires: wallet addresses, usernames, `trd_` ids or integer trader
   * ids, resolved in input order. Until #16135 this method sent the array as
   * `identifiers`, a field the route does not declare, so every call was
   * refused for a missing `traders`. `options.expand` is sent as the body's
   * `expand` array and applies to every item.
   *
   * The response `data` keeps request order and one row per input, duplicates
   * included; a row is `status: "ok"` with `data`, or `status: "error"` with
   * the item's own `error`. An identity that resolves to nothing is a per-item
   * error, never a request failure, and since #18135 the route answers the
   * `not_found` this comment already promised: a username, `trd_` id or
   * numeric trader id that names no trader is `not_found` with `error.param`
   * `"traders"`, where it used to be an `ok` row with the input echoed into
   * `address`. A wallet address the API does not track yet stays `ok` with
   * `sync_status: "unknown"`, because that address is real and may still be
   * graded. `meta` is the batch's `BatchResponseMeta`: `request_cost` and
   * `rate_limit` follow the batch item quota, not the per-request one.
   */
  batchGetTraders(
    traders: OperationBody["batchGetTraders"]["traders"],
    options: BatchGetTradersOptions = {},
  ) {
    const { expand, ...request } = options;
    return this.call("batchGetTraders", {
      ...request,
      body: expand === undefined ? { traders } : { traders, expand },
    });
  }

  /**
   * Resolve up to 25 markets' flow and top positions in one request
   * (`POST /api/v1/markets/flow/batch`); `meta` is the batch's own.
   */
  batchGetMarketFlow(
    body: OperationBody["batchGetMarketFlow"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("batchGetMarketFlow", { ...options, body });
  }

  /**
   * @deprecated Use {@link batchGetMarketFlow} (#16312); calls the deprecated
   * `POST /api/v1/markets/intel/batch`, whose envelope keeps
   * `object: "market_intel_batch"`.
   */
  batchGetMarketIntel(
    body: OperationBody["batchGetMarketIntel"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("batchGetMarketIntel", { ...options, body });
  }

  listLeaderboard(params: LeaderboardListParams = {}, options: ConvenienceOptions = {}) {
    return this.list("listLeaderboard", { ...options, query: params });
  }

  listTrendingWallets(params: TrendingWalletsParams = {}, options: ConvenienceOptions = {}) {
    return this.list("listTrendingWallets", { ...options, query: params });
  }

  listLargeTrades(params: LargeTradeListParams = {}, options: ConvenienceOptions = {}) {
    return this.list("listLargeTrades", { ...options, query: params });
  }

  /**
   * Typed conditional-read variant of {@link listLargeTrades}, for polling
   * (#18507). Returns the list envelope on 200 or the typed `not_modified`
   * result on 304, where {@link listLargeTrades} throws on a 304. Pass
   * `since` (the id of the first trade of your last answer that had trades)
   * with `If-None-Match`: a poll that finds no new trade is a 304 with no body.
   */
  listLargeTradesConditional(
    params: LargeTradeListParams = {},
    options: ConvenienceOptions = {},
  ) {
    return this.call("listLargeTrades", { ...options, query: params });
  }

  listLargeTradeHistory(
    params: LargeTradeHistoryParams = {},
    options: ConvenienceOptions = {},
  ) {
    return this.list("listLargeTradeHistory", { ...options, query: params });
  }

  /** @deprecated Use {@link listLargeTrades} (#16304); calls the deprecated `/api/v1/whale-trades`. */
  listWhaleTrades(params: WhaleTradeListParams = {}, options: ConvenienceOptions = {}) {
    return this.list("listWhaleTrades", { ...options, query: params });
  }

  /** @deprecated Use {@link listLargeTradeHistory} (#16304); calls the deprecated `/api/v1/whale-trades/history`. */
  listWhaleTradeHistory(
    params: WhaleTradeHistoryParams = {},
    options: ConvenienceOptions = {},
  ) {
    return this.list("listWhaleTradeHistory", { ...options, query: params });
  }

  listPositions(params: PositionsListParams = {}, options: ConvenienceOptions = {}) {
    return this.list("listPositions", { ...options, query: params });
  }

  listLargePositions(
    params: LargePositionsListParams = {},
    options: ConvenienceOptions = {},
  ) {
    return this.list("listLargePositions", { ...options, query: params });
  }

  /**
   * List ranked sharp-money flows. Canonical since #16308 ("sharp money" is
   * the pinned product term); it calls `/api/v1/markets/sharp-money-flows`.
   */
  listSharpMoneyFlows(params: SharpMoneyFlowsParams = {}, options: ConvenienceOptions = {}) {
    return this.list("listSharpMoneyFlows", { ...options, query: params });
  }

  /**
   * @deprecated Use {@link listSharpMoneyFlows} (#16308). Kept live; it calls
   * the deprecated `/api/v1/markets/smart-money-flows`, whose responses carry
   * `Deprecation` and a `Link rel="successor-version"`.
   */
  listSmartMoneyFlows(
    params: OperationQuery["listSmartMoneyFlows"] = {},
    options: ConvenienceOptions = {},
  ) {
    return this.list("listSmartMoneyFlows", { ...options, query: params });
  }

  /**
   * List covered games: both sides with their provider ids and live scores, the
   * UTC kickoff, the provider's own status, and every linked Polymarket market
   * with its condition id and outcome token ids. Ordered by kickoff, then by
   * `event_slug`, with unscheduled games last. An unknown `sport` or `status`
   * returns an empty page rather than an error, and the response's `coverage`
   * names what this deployment serves.
   */
  listGames(params: GamesListParams = {}, options: ConvenienceOptions = {}) {
    return this.list("listGames", { ...options, query: params });
  }

  /**
   * Read one game by its `event_slug`, the identity the `live_sports_updated`
   * webhook pulse carries. A slug outside the published coverage returns 404.
   */
  getGame(
    eventSlug: OperationPath["getGame"]["event_slug"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("getGame", { ...options, path: { event_slug: eventSlug } });
  }

  /**
   * List upcoming games and their public market-side data.
   * Rows carry `side`, `ranked_at`,
   * `backing_score` and `side_share`; the older `piled_side`,
   * `signal_created_at`, `conviction_score` and `smart_score` keys carry the
   * same values and stay on the wire.
   */
  listPreGameSides(params: PreGameSidesParams = {}, options: ConvenienceOptions = {}) {
    return this.list("listPreGameSides", { ...options, query: params });
  }

  /**
   * @deprecated Use {@link listPreGameSides} (#16310). Kept live; it calls the
   * deprecated `/api/v1/sports-edge-signals` path, which answers with
   * `Deprecation` and successor `Link` headers and the same body.
   */
  listSportsEdgeSignals(params: SportsEdgeSignalsParams = {}, options: ConvenienceOptions = {}) {
    return this.list("listSportsEdgeSignals", { ...options, query: params });
  }

  /**
   * Read an explicitly observation-only sports cohort and its accountable
   * per-sport funnel. This surface is isolated from the funded signals route.
   * Healthy wider-holder and emerging-pile snapshots may be served for about
   * 180 seconds; in-play cached snapshots are capped at about 30 seconds and
   * stale provider live-board evidence fails closed. emerging-pile is an
   * additive wider-holder projection, not an arrival-history or independent
   * denominator view.
   */
  async listPreGameSideObservations(
    params: PreGameSideObservationsParams,
    options: ConvenienceOptions = {},
  ): Promise<PreGameSideObservationsResponse> {
    const response = await this.list("listPreGameSideObservations", {
      ...options,
      query: params,
    });
    return sportsEdgeObservationsResponse(response);
  }

  /**
   * @deprecated Use {@link listPreGameSideObservations} (#16310). Kept live; it
   * calls the deprecated `/api/v1/sports-edge-observations` path, which answers
   * with `Deprecation` and successor `Link` headers and the same body.
   */
  async listSportsEdgeObservations(
    params: SportsEdgeObservationsParams,
    options: ConvenienceOptions = {},
  ): Promise<SportsEdgeObservationsResponse> {
    const response = await this.list("listSportsEdgeObservations", {
      ...options,
      query: params,
    });
    return sportsEdgeObservationsResponse(response);
  }

  /**
   * Typed conditional-read variant of {@link listSportsEdgeObservations}.
   * Returns the full observation response on 200 or a typed `not_modified`
   * envelope on 304 instead of routing the latter through generic `call()`.
   * The endpoint emits a weak semantic ETag over the stable response payload;
   * request-specific `meta` is excluded. For emerging-pile, the opaque
   * projection cutoff inside `next_cursor` is excluded while its stable page
   * position remains covered.
   */
  async listPreGameSideObservationsConditional(
    params: PreGameSideObservationsParams,
    options: ConvenienceOptions = {},
  ): Promise<PreGameSideObservationsResponse | ApiNotModifiedResponse> {
    const response = await this.call("listPreGameSideObservations", {
      ...options,
      query: params,
    });
    if (isNotModified(response)) {
      return response;
    }
    return sportsEdgeObservationsResponse(response);
  }

  /**
   * @deprecated Use {@link listPreGameSideObservationsConditional} (#16310).
   * Kept live on the deprecated `/api/v1/sports-edge-observations` path.
   */
  async listSportsEdgeObservationsConditional(
    params: SportsEdgeObservationsParams,
    options: ConvenienceOptions = {},
  ): Promise<SportsEdgeObservationsResponse | ApiNotModifiedResponse> {
    const response = await this.call("listSportsEdgeObservations", {
      ...options,
      query: params,
    });
    if (isNotModified(response)) {
      return response;
    }
    return sportsEdgeObservationsResponse(response);
  }

  searchMarkets(
    q: OperationQuery["searchMarkets"]["q"],
    options: ConvenienceOptions & { query?: Omit<OperationQuery["searchMarkets"], "q"> } = {},
  ) {
    const { query, ...request } = options;
    return this.list("searchMarkets", { ...request, query: { ...query, q } });
  }

  searchContent(
    q: OperationQuery["searchContent"]["q"],
    options: ConvenienceOptions & { query?: Omit<OperationQuery["searchContent"], "q"> } = {},
  ) {
    const { query, ...request } = options;
    return this.list("searchContent", { ...request, query: { ...query, q } });
  }

  exploreMarkets(params: ExploreMarketsParams = {}, options: ConvenienceOptions = {}) {
    return this.list("exploreMarkets", { ...options, query: params });
  }

  /** One market's flow and top positions (`GET /api/v1/market/{condition_id}/flow`). */
  getMarketFlow(
    conditionId: OperationPath["getMarketFlow"]["condition_id"],
    options: Omit<OperationRequestOptions<"getMarketFlow">, "path"> = {},
  ) {
    return this.call("getMarketFlow", {
      ...options,
      path: { condition_id: conditionId },
    });
  }

  /**
   * @deprecated Use {@link getMarketFlow} (#16312); calls the deprecated
   * `GET /api/v1/market/{condition_id}/intel`, whose envelope keeps
   * `object: "market_intel"`.
   */
  getMarketIntel(
    conditionId: OperationPath["getMarketIntel"]["condition_id"],
    options: Omit<OperationRequestOptions<"getMarketIntel">, "path"> = {},
  ) {
    return this.call("getMarketIntel", {
      ...options,
      path: { condition_id: conditionId },
    });
  }

  getMarketSnapshot(
    conditionId: OperationPath["getMarketSnapshot"]["condition_id"],
    options: Omit<OperationRequestOptions<"getMarketSnapshot">, "path"> = {},
  ) {
    return this.call("getMarketSnapshot", {
      ...options,
      path: { condition_id: conditionId },
    });
  }

  /**
   * One page of a market's graded (S/A/B) holder roster from a complete
   * provider holder scan: the list a Pick of the Day shows, for any market.
   * `params.outcome` (`yes` | `no` | `all`), `params.min_grade` (`S` | `A` |
   * `B`), `params.limit` and `params.cursor` (`mh_` prefix). The page carries
   * the `market`, `scan` and roster `totals` beside `data`; `total` is the
   * count matching the filters across every page.
   */
  getMarketHolders(
    conditionId: OperationPath["getMarketHolders"]["condition_id"],
    params: OperationQuery["getMarketHolders"] = {},
    options: ConvenienceOptions = {},
  ) {
    return this.list("getMarketHolders", {
      ...options,
      path: { condition_id: conditionId },
      query: params,
    });
  }

  /**
   * Fetch bucketed OHLC candles for a market's outcome tokens.
   * Resolution defaults to the server default; pass `params.resolution` as
   * `"1d"` or `"1w"` to override. `params.from` is exclusive and `params.to`
   * is inclusive; when both are present, `from` must be less than or equal to
   * `to`.
   */
  getMarketCandles(
    conditionId: OperationPath["getMarketCandles"]["condition_id"],
    params: OperationQuery["getMarketCandles"] = {},
    options: ConvenienceOptions = {},
  ) {
    return this.call("getMarketCandles", {
      ...options,
      path: { condition_id: conditionId },
      query: params,
    });
  }

  /**
   * Fetch one suspicious trade by raw `whale_alerts.id` or the `rf_`-prefixed
   * id list responses emit. The envelope's `object` is `"suspicious_trade"`.
   */
  getSuspiciousTrade(
    id: OperationPath["getSuspiciousTrade"]["id"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("getSuspiciousTrade", { ...options, path: { id } });
  }

  /** List stored trades whose recorded suspicion score meets the flag threshold. */
  listSuspiciousTrades(
    params: SuspiciousTradesListParams = {},
    options: ConvenienceOptions = {},
  ) {
    return this.list("listSuspiciousTrades", { ...options, query: params });
  }

  /**
   * @deprecated Use `getSuspiciousTrade()`; renamed in #16301. This method
   * keeps calling the deprecated `GET /api/v1/insider-radar/{id}`, which stays
   * live with no retirement date and still answers `object: "radar_flag"`, so
   * an integration branching on that envelope keeps working.
   */
  getInsiderRadarFlag(
    id: OperationPath["getInsiderRadarFlag"]["id"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("getInsiderRadarFlag", { ...options, path: { id } });
  }

  /**
   * @deprecated Use `listSuspiciousTrades()`; renamed in #16301. This method
   * keeps calling the deprecated `GET /api/v1/insider-radar`, which stays live
   * with no retirement date and answers with `Deprecation` plus a `Link
   * rel="successor-version"` header.
   */
  listInsiderRadar(params: InsiderRadarListParams = {}, options: ConvenienceOptions = {}) {
    return this.list("listInsiderRadar", { ...options, query: params });
  }

  getLargeTrade(
    id: OperationPath["getLargeTrade"]["id"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("getLargeTrade", { ...options, path: { id } });
  }

  /** @deprecated Use {@link getLargeTrade} (#16304); calls the deprecated `/api/v1/whale-trades/{id}`. */
  getWhaleTrade(
    id: OperationPath["getWhaleTrade"]["id"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("getWhaleTrade", { ...options, path: { id } });
  }

  // --- Exports ---

  /**
   * Cancel a submitted export (`POST /api/v1/trader/{address}/export/cancel`, #16254).
   *
   * Resolves to the job resource after the cancel, the same shape
   * `getTraderExportStatus` returns: `cancelled` for a job no worker had
   * started, `cancel_requested` for a running one (poll the status route at
   * `poll_after_s` until it reads `cancelled`), or the job unchanged when a
   * cancel can no longer reach it (its file is being published, or it is
   * already terminal). Compare `status` rather than assuming success. A
   * cancel never deletes a ready file, never returns quota, and is safe to
   * repeat, so it is retried on a transport or 5xx failure like a read.
   */
  cancelTraderExport(
    address: OperationPath["cancelTraderExport"]["address"],
    jobId: OperationQuery["cancelTraderExport"]["job_id"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("cancelTraderExport", {
      ...options,
      path: { address },
      query: { job_id: jobId },
    });
  }

  // --- Webhooks ---

  listWebhooks(options: ConvenienceOptions = {}) {
    return this.list("listWebhooks", options);
  }

  getWebhook(
    id: OperationPath["getWebhook"]["id"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("getWebhook", { ...options, path: { id } });
  }

  createWebhook(
    body: OperationBody["createWebhook"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("createWebhook", { ...options, body });
  }

  /** Admit durable consent; 202 acknowledges admission, not activation. */
  createWebhookVerificationAttempt(
    id: OperationPath["createWebhookVerificationAttempt"]["id"],
    body: OperationBody["createWebhookVerificationAttempt"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("createWebhookVerificationAttempt", { ...options, path: { id }, body });
  }

  /** Poll current consent state without issuing or restarting a challenge. */
  getWebhookVerificationAttempt(
    id: OperationPath["getWebhookVerificationAttempt"]["id"],
    attemptId: OperationPath["getWebhookVerificationAttempt"]["attempt_id"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("getWebhookVerificationAttempt", { ...options, path: { id, attempt_id: attemptId } });
  }

  updateWebhook(
    id: OperationPath["updateWebhook"]["id"],
    body: OperationBody["updateWebhook"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("updateWebhook", { ...options, path: { id }, body });
  }

  deleteWebhook(
    id: OperationPath["deleteWebhook"]["id"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("deleteWebhook", { ...options, path: { id } });
  }

  /**
   * Fetch the self-describing webhook event catalog (each entry's `id`,
   * description, payload shape, and active/dormant status).
   */
  listWebhookEvents(options: ConvenienceOptions = {}) {
    return this.list("listWebhookEvents", options);
  }

  /** List delivery attempts for one webhook endpoint (Stripe-style list). */
  listWebhookDeliveries(
    webhookId: OperationPath["listWebhookDeliveries"]["id"],
    params: OperationQuery["listWebhookDeliveries"] = {},
    options: ConvenienceOptions = {},
  ) {
    return this.list("listWebhookDeliveries", {
      ...options,
      path: { id: webhookId },
      query: params,
    });
  }

  /**
   * Requeue one `dead_letter` delivery with a fresh attempt budget and return
   * the delivery row. Re-enabling a disabled endpoint resends nothing, so this
   * is how its dead-lettered deliveries are recovered. The API answers 409 when
   * the delivery is already delivered or still queued, or when the endpoint is
   * disabled, unverified, or no longer subscribed to the delivery's event type;
   * the error message names the fix. Pass `idempotencyKey` to make a retry safe.
   */
  redeliverWebhookDelivery(
    webhookId: OperationPath["redeliverWebhookDelivery"]["id"],
    deliveryId: OperationPath["redeliverWebhookDelivery"]["delivery_id"],
    options: ConvenienceOptions = {},
  ) {
    return this.call("redeliverWebhookDelivery", {
      ...options,
      path: { id: webhookId, delivery_id: deliveryId },
    });
  }

  // --- System ---

  getHealth(options: ConvenienceOptions = {}) {
    return this.call("getHealth", options);
  }

  getApiDiscovery(options: ConvenienceOptions = {}) {
    return this.call("getApiDiscovery", options);
  }

  /**
   * Which V1 reads the API serves for Polymarket (`GET /api/v1/coverage`).
   * Public: needs no API key.
   */
  getCoverage(options: ConvenienceOptions = {}) {
    return this.call("getCoverage", options);
  }

  /**
   * @deprecated Use {@link getCoverage} (#16315); calls the deprecated
   * `GET /api/v1/platforms`, which serves the same body.
   */
  getPlatforms(options: ConvenienceOptions = {}) {
    return this.call("getPlatforms", options);
  }

  getAccountIdentity(options: ConvenienceOptions = {}) {
    return this.call("getAccountIdentity", options);
  }

  /**
   * One wallet's context as Markdown, ready to paste into a model prompt
   * (`GET /api/v1/trader/{address}/context.md`). The JSON form of the same
   * read is `getTraderContext`.
   */
  getTraderContextMarkdown(
    address: OperationPath["getTraderContextMarkdown"]["address"],
    options: Omit<
      OperationRequestOptions<"getTraderContextMarkdown">,
      "path"
    > = {},
  ): Promise<string> {
    return this.text("getTraderContextMarkdown", { ...options, path: { address } });
  }

  /**
   * One market's context as Markdown
   * (`GET /api/v1/market/{condition_id}/context.md`). The JSON form is
   * `getMarketSnapshot`.
   */
  getMarketContextMarkdown(
    conditionId: OperationPath["getMarketContextMarkdown"]["condition_id"],
    options: Omit<
      OperationRequestOptions<"getMarketContextMarkdown">,
      "path"
    > = {},
  ): Promise<string> {
    return this.text("getMarketContextMarkdown", {
      ...options,
      path: { condition_id: conditionId },
    });
  }

  /**
   * Mint a sandbox key (`POST /api/v1/agents/register`), the one write that
   * needs no credential. Answers `201`, which is why the SDK had no method
   * for it until #16137: the drift gate counted only operations with a
   * documented `200`. `meta.status` is `201`; `data.api_key` is the
   * `oxi_sk_test_*` key to pass to `OxinsiderApiClient.sandbox()`.
   *
   * Nothing is stored: the key cannot be listed or revoked and does not
   * expire. Register again for another one.
   */
  registerAgent(options: ConvenienceOptions = {}) {
    return this.call("registerAgent", options);
  }

  getUsage(options: ConvenienceOptions = {}) {
    return this.call("getUsage", options);
  }

  /** Fetch today's editorial Pick of the Day (single-object envelope). */
  getPickOfTheDay(options: ConvenienceOptions = {}) {
    return this.call("getPickOfTheDay", options);
  }

  /** Fetch the Pick of the Day archive with hit-rate (single-object envelope). */
  getPickOfTheDayArchive(options: ConvenienceOptions = {}) {
    return this.call("getPickOfTheDayArchive", options);
  }

  /**
   * Fetch the Pick of the Day commitment ledger (single-object envelope).
   *
   * Every entry is `sealed` (a live pick: the hash, no side and no price),
   * `opened` (a settled pick: the nonce and the exact hashed payload) or
   * `uncommitted` (no commitment; once settled, its unhashed side and price
   * under `payload`). Verify an opened entry by
   * appending the hex-decoded `commitment_nonce` to the `payload` bytes as
   * received and hashing with sha256; do not reserialize the payload, since it
   * is served byte for byte as it was hashed.
   */
  getPickOfTheDayLedger(options: ConvenienceOptions = {}) {
    return this.call("getPickOfTheDayLedger", options);
  }

  /** Read a published pick's proof by stable decimal-string pick id. */
  getPickOfTheDayLedgerEntry(pickId: string, options: ConvenienceOptions = {}) {
    return this.call("getPickOfTheDayLedgerEntry", { ...options, path: { pick_id: pickId } });
  }

  // --- Internals ---

  /** Resolve the base URL (used by the SSE stream consumer). */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** The configured API key, if any (used by the SSE stream consumer). */
  getApiKey(): string | undefined {
    return this.apiKey;
  }

  /** Whether this client was built in sandbox mode (#16138). */
  isSandbox(): boolean {
    return this.sandbox;
  }

  /** The resolved fetch implementation (used by the SSE stream consumer). */
  getFetch(): typeof fetch {
    return this.fetchImpl;
  }

  buildUrl(operation: ApiClientOperation, options: ApiRequestOptions): string {
    const url = resolveApiUrl(
      this.baseUrl,
      interpolatePath(operation.path, options.path ?? {}),
    );
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === null || value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildHeaders(
    operation: ApiClientOperation,
    options: ApiRequestOptions,
    accept = "application/json",
  ): Headers {
    const headers = new Headers(options.headers);
    headers.set("accept", accept);
    if (options.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (operation.auth === "bearer" && this.apiKey) {
      headers.set("authorization", `Bearer ${this.apiKey}`);
    }
    if (options.idempotencyKey !== undefined) {
      headers.set("idempotency-key", options.idempotencyKey);
    }
    // Validate the effective value after the explicit option has overridden
    // custom headers. The backend trims it before checking its byte limit;
    // a blank header is treated as no durable replay key (#19748).
    const idempotencyKey = headers.get("idempotency-key");
    if (idempotencyKey !== null) {
      const key = idempotencyKey.trim();
      if (key.length === 0 || new TextEncoder().encode(key).byteLength > 255) {
        throw new Error(
          "Idempotency-Key must be nonempty after trimming and at most 255 UTF-8 bytes. Supply a stable nonempty key or omit it to send the mutation once.",
        );
      }
    }
    if (options.strictQuery) {
      headers.set("x-query-validation", "strict");
    }
    return headers;
  }
}

/**
 * Narrow a `call()` result to the typed 304. Takes any envelope-shaped
 * value, so it works on an `OperationResult<K>` (whose `meta` is the
 * operation's own type) as well as the loose `ApiClientResponse<T>`
 * (#16136).
 */
export function isApiNotModifiedResponse<R extends { object: string }>(
  response: R,
): response is Extract<R, ApiNotModifiedResponse> {
  return response.object === "not_modified";
}

function isNotModified<R extends { object: string }>(
  response: R,
): response is Extract<R, ApiNotModifiedResponse> {
  return response.object === "not_modified";
}

export function interpolatePath(
  path: string,
  params: Partial<Record<string, string | number>>,
): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

async function readResponseText(response: Response): Promise<string> {
  const unusable = response.bodyUsed || response.body?.locked === true;
  try {
    return await response.text();
  } catch (error) {
    // A consumed/locked custom-fetch response or failed allocation is a local
    // contract failure, rather than evidence of a transport interruption.
    if (unusable || error instanceof RangeError) throw error;
    throw new ResponseBodyReadError(response.status, error);
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await readResponseText(response);
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function notModifiedResponse(response: Response): ApiNotModifiedResponse {
  const meta: ApiNotModifiedResponse["meta"] = { status: 304 };
  const etag = response.headers.get("etag");
  if (etag) {
    meta.etag = etag;
  }
  const requestId = response.headers.get("x-request-id");
  if (requestId) {
    meta.request_id = requestId;
  }
  const queryIgnored = response.headers.get("x-query-ignored");
  if (queryIgnored) {
    meta.queryIgnored = queryIgnored;
  }
  const effectiveQuery = response.headers.get("x-effective-query");
  if (effectiveQuery) {
    meta.effectiveQuery = effectiveQuery;
  }
  return { object: "not_modified", data: null, meta };
}

function isApiEnvelope<T>(body: unknown): body is ApiEnvelope<T> {
  return (
    typeof body === "object" &&
    body !== null &&
    "object" in body &&
    "data" in body
  );
}

/**
 * Whether `body` is a list envelope whose control fields the walker can act
 * on: `object: "list"`, an array `data`, a BOOLEAN `has_more`, and a
 * `next_cursor` that is a string, `null` or absent (#16246: the check used to
 * accept any `has_more` that was merely present, so a malformed value could
 * be coerced into "no more pages" or "more pages" by truthiness).
 */
export function isListEnvelope<T>(body: unknown): body is ApiListEnvelope<T> {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as {
    object?: unknown;
    data?: unknown;
    has_more?: unknown;
    next_cursor?: unknown;
  };
  return (
    candidate.object === "list" &&
    Array.isArray(candidate.data) &&
    typeof candidate.has_more === "boolean" &&
    (candidate.next_cursor === undefined ||
      candidate.next_cursor === null ||
      typeof candidate.next_cursor === "string")
  );
}

function sportsEdgeObservationsResponse(
  response: OperationEnvelope<"listSportsEdgeObservations">,
): SportsEdgeObservationsResponse {
  const candidate = response as unknown as Record<string, unknown>;
  const funnel = candidate["funnel"] as Record<string, unknown> | null | undefined;
  const meta = candidate["meta"] as Record<string, unknown> | null | undefined;
  if (
    candidate["object"] !== "list" ||
    !Array.isArray(candidate["data"]) ||
    typeof candidate["has_more"] !== "boolean" ||
    !(
      candidate["next_cursor"] === null ||
      typeof candidate["next_cursor"] === "string"
    ) ||
    typeof candidate["snapshot_as_of"] !== "string" ||
    typeof candidate["degraded"] !== "boolean" ||
    typeof funnel !== "object" ||
    funnel === null ||
    Array.isArray(funnel) ||
    !Array.isArray(funnel["sports"]) ||
    typeof meta !== "object" ||
    meta === null ||
    Array.isArray(meta) ||
    typeof meta["request_id"] !== "string" ||
    typeof meta["cached"] !== "boolean" ||
    typeof meta["cost"] !== "number" ||
    !Number.isInteger(meta["cost"])
  ) {
    throw new OxinsiderApiError(200, {
      object: "error",
      error: {
        code: "invalid_response",
        message:
          "listSportsEdgeObservations returned an invalid required response envelope",
      },
    });
  }
  return response;
}
