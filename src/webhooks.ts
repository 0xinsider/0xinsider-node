/**
 * Webhook signature verification and typed delivery payloads.
 *
 * The backend signs every webhook delivery exactly like this (source of truth:
 * `backend/src/api_v1/handlers/webhooks/endpoint_security.rs::sign_webhook_payload`):
 *
 *   signature = "v1=" + hex( HMAC_SHA256( signing_secret, `${timestamp}.${raw_body}` ) )
 *
 * It is sent on two headers:
 *   - `x-0xinsider-timestamp: <unix-seconds>`
 *   - `x-0xinsider-signature: v1=<hex>`   (may be a comma-separated list)
 *
 * Verification, the receiver side. The backend only signs; the published
 * recipe is the delivery-signing paragraph on POST /api/v1/webhooks in
 * `web/public/api/v1/openapi.json`:
 *   1. Reject if `|now - timestamp| > 300` seconds (replay tolerance).
 *   2. Recompute the expected `v1=<hex>` over `${timestamp}.${rawBody}`.
 *   3. Constant-time compare against each candidate in the header.
 *
 * `rawBody` MUST be the exact bytes received: verify before JSON parsing, since
 * re-serializing changes whitespace/key order and breaks the HMAC.
 *
 * ENDPOINT ACTIVATION (`verifyWebhook`, `POST /api/v1/webhooks/{id}/verify`):
 * the one-time `verification.token` is necessary but not sufficient. That call
 * POSTs a challenge to your webhook url and activates the endpoint only if you
 * answer 2xx within 10 seconds. The challenge body is
 * `{ "type": "webhook.verification", "token": "<verification_token>",
 * "webhook_id": <id> }`, it carries `x-0xinsider-event-type:
 * webhook.verification`, and it is signed with the endpoint's `signing_secret`
 * exactly like a delivery -- so `verifySignature` below validates it unchanged.
 * The challenge follows no redirects and never reads your response body. A
 * non-2xx answer, no answer inside 10 seconds, or a url that does not resolve to
 * a publicly routable address returns 422 and leaves the endpoint
 * `pending_verification`.
 *
 * For durable asynchronous consent, call `createWebhookVerificationAttempt`
 * with the token and an `Idempotency-Key`, then poll
 * `getWebhookVerificationAttempt`. The 202 response acknowledges admission;
 * only state `verified` activates the destination. Its signed challenge adds
 * `verification_attempt_id` and `x-0xinsider-verification-attempt`, stable
 * across at-least-once retries. Terminal states never restart on polling or
 * replay. The legacy synchronous method and its retry restriction remain.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  LargeTradesInsertedData,
  SharpMoneyFlowDetectedData,
  SuspiciousTradeFlaggedData,
  TraderSyncedData,
  WebhookEventData,
  WebhookEventType as ContractWebhookEventType,
} from "./schema.js";

/** Default replay tolerance; the published contract is 300 seconds. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Header carrying the `v1=<hex>` signature. */
export const SIGNATURE_HEADER = "x-0xinsider-signature";
/** Header carrying the unix-seconds signing timestamp. */
export const TIMESTAMP_HEADER = "x-0xinsider-timestamp";

export interface VerifySignatureInput {
  /** The endpoint's signing secret (returned on create / rotate-secret/prepare / rotate-secret/activate). */
  secret: string;
  /** The `x-0xinsider-timestamp` value (unix seconds, number or string). */
  timestamp: number | string;
  /** The exact raw request body bytes/string, pre-JSON-parse. */
  body: string | Uint8Array;
  /** The `x-0xinsider-signature` header value (`v1=<hex>`, possibly a list). */
  signature: string;
  /**
   * Replay tolerance in seconds; defaults to `SIGNATURE_TOLERANCE_SECONDS`
   * (300, the published contract). A finite number of at least 0: a payload
   * whose timestamp is more than this many seconds from `nowSeconds`, in
   * either direction, is rejected, and exactly this many seconds away is
   * accepted (the check is `|now - timestamp| > tolerance`). `0` accepts only
   * the current second. `NaN`, `Infinity`, `-Infinity` or a negative value is
   * a configuration error and throws, since each would silently turn the
   * replay window off (#16183): `Math.abs(x) > NaN` is never true, and
   * `> Infinity` never is either.
   */
  toleranceSeconds?: number;
  /** Reference "now" in unix seconds; defaults to `Date.now()/1000`. */
  nowSeconds?: number;
}

/**
 * Recompute the canonical signature for a payload. Returns `v1=<hex>`.
 * Exposed so callers can sign in tests; matches the backend byte-for-byte.
 */
export function computeSignature(
  secret: string,
  timestamp: number | string,
  body: string | Uint8Array,
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(String(timestamp));
  hmac.update(".");
  hmac.update(typeof body === "string" ? Buffer.from(body, "utf-8") : body);
  return `v1=${hmac.digest("hex")}`;
}

/**
 * Verify a webhook signature. Returns `true` only when the timestamp is within
 * tolerance AND a candidate signature constant-time-matches the recomputed one.
 * Never throws on a bad signature or a malformed timestamp (those return
 * `false`); throws only on receiver misconfiguration: a missing/empty secret,
 * or a `toleranceSeconds` that is not a finite number of at least 0 (#16183).
 * The two are told apart on purpose: a `false` is the sender's problem and is
 * answered with a 4xx, a throw is the receiver's own bug and should reach a
 * log, not be mistaken for a forged delivery.
 */
export function verifySignature(input: VerifySignatureInput): boolean {
  if (!input.secret) {
    throw new Error("verifySignature requires a non-empty signing secret");
  }

  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  // Fail closed on a tolerance that cannot bound anything. `Math.abs(now - ts)
  // > NaN` is false for every age, and so is `> Infinity`, so either would
  // admit a correctly signed payload of any age; a negative tolerance would
  // reject everything, which is a misconfiguration too, not a policy.
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(
      `verifySignature toleranceSeconds must be a finite number of at least 0, got ${String(tolerance)}`,
    );
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  // Guard a caller-injected non-finite `now` (e.g. NaN): a non-finite reference
  // time would make `Math.abs(now - ts) > tolerance` false and silently skip the
  // replay-window check, so reject outright rather than verify on the HMAC alone.
  if (!Number.isFinite(now)) {
    return false;
  }
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }
  if (Math.abs(now - ts) > tolerance) {
    return false;
  }

  const expected = computeSignature(input.secret, ts, input.body);
  const expectedBuf = Buffer.from(expected, "utf-8");

  // The header may carry multiple comma-separated candidate signatures.
  return input.signature
    .split(",")
    .map((part) => part.trim())
    .some((candidate) => constantTimeEqual(candidate, expectedBuf));
}

function constantTimeEqual(candidate: string, expected: Buffer): boolean {
  const candidateBuf = Buffer.from(candidate, "utf-8");
  // timingSafeEqual throws on length mismatch; the length check itself is not
  // secret (signature length is public), so guard first.
  if (candidateBuf.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(candidateBuf, expected);
}

// --- Typed webhook payloads ---

/**
 * Webhook event types, as a runtime list. Source of truth:
 * `web/public/api/v1/openapi.json` -> components.schemas.WebhookEventType.enum,
 * which `schema.ts` carries as the generated `WebhookEventType` union.
 * `large_trade_inserted_v2`, `large_trades_inserted`, `whale_trades_inserted`,
 * `wallet_grade_changed`, `suspicious_trade_flagged`,
 * `insider_radar_flag_raised`, `sharp_money_flow_detected`, and
 * `smart_money_flow_detected` are Pro and Max: they deliver only to API keys
 * on an active Pro or Max subscription.
 *
 * Some entries are two spellings of ONE event, not two events: either one
 * subscribes, and an endpoint receives its deliveries under the spelling it
 * registered. The canonical spelling is listed first of each pair --
 * `large_trades_inserted` over `whale_trades_inserted` and `trader_synced`
 * over `whale_trader_synced` (#16304), `suspicious_trade_flagged` over
 * `insider_radar_flag_raised` (#16301), and `sharp_money_flow_detected` over
 * `smart_money_flow_detected` (#16308). No deprecated spelling is ever
 * removed.
 *
 * This list, the generated union and the typed envelopes in `WebhookEvent`
 * are one set, and the compiler holds them equal (#24603). Each is checked as
 * a subset of the next: `satisfies` below refuses a name with no typed
 * envelope, the `WebhookEventEnvelope` constraint refuses an envelope for a
 * name the contract does not have, and `WebhookEventType` refuses a contract
 * name this list lacks. A new event type therefore fails the SDK build until
 * it is listed here and typed below. Before that check, the list missed
 * `large_trade_inserted_v2` for three weeks after the API began offering it.
 *
 * A new name goes at the end, so the index of every earlier name is unchanged.
 */
export const WEBHOOK_EVENT_TYPES = [
  "large_trades_inserted",
  "whale_trades_inserted",
  "live_sports_updated",
  "trader_synced",
  "whale_trader_synced",
  "large_positions_updated",
  "wallet_grade_changed",
  "suspicious_trade_flagged",
  "insider_radar_flag_raised",
  // Pro and Max. `sharp_money_flow_detected` is the canonical spelling since
  // #16308 ("sharp money" is the pinned product term);
  // `smart_money_flow_detected` is its deprecated twin, kept live, and stays
  // the `type` an endpoint that registered it receives.
  "sharp_money_flow_detected",
  "smart_money_flow_detected",
  "export_job_ready",
  "export_job_failed",
  "export_job_expired",
  "export_job_cancelled",
  // Pro and Max. One large trade per delivery, with the trade in `data`
  // (#16149); `large_trades_inserted` and its twin carry only a count.
  "large_trade_inserted_v2",
] as const satisfies readonly WebhookEvent["type"][];

/**
 * `T`, unchanged, when `Missing` is `never`. Any other `Missing` fails its
 * constraint, so the compile error names what is missing.
 */
type Complete<T, Missing extends never> = T | Missing;

/**
 * Every webhook event type: the generated contract union. It compiles only
 * while `WEBHOOK_EVENT_TYPES` lists every name in the contract, and the error
 * names the one the list lacks.
 */
export type WebhookEventType = Complete<
  ContractWebhookEventType,
  Exclude<ContractWebhookEventType, (typeof WEBHOOK_EVENT_TYPES)[number]>
>;

/**
 * Common delivery envelope every webhook POST body carries. Source of truth:
 * `WebhookEnvelope` in `backend/crates/core/src/webhook_payloads.rs`, which
 * every entry of the OpenAPI document's `webhooks` map describes.
 */
export interface WebhookEventEnvelope<
  TType extends WebhookEventType = WebhookEventType,
  TData = unknown,
> {
  /** Stable event id; identical across retries of the same logical event. */
  id: string;
  type: TType;
  /**
   * When the producer recorded the event (ISO 8601); for a trade event, the
   * fill time. Retries resend the same body, so it is not the time of the
   * attempt.
   */
  created_at: string;
  data: TData;
}

// Every `data` payload is generated into `schema.ts` from the OpenAPI document
// (#24940): the backend builds each payload from a typed struct,
// `tools/run check-openapi-nullability` holds each struct to its schema, and
// the generated `WebhookEventData` pairs each event type with its payload.
// Change a payload in the document and regenerate; never declare one here.
export type {
  ExportJobCancelledData,
  ExportJobExpiredData,
  ExportJobFailedData,
  ExportJobReadyData,
  LargePositionsUpdatedData,
  LargeTradeInsertedV2Data,
  LargeTradesInsertedData,
  LiveSportsScoreEntry,
  LiveSportsUpdatedData,
  SharpMoneyFlowDetectedData,
  SuspiciousTradeFlaggedData,
  TraderSyncedData,
  WalletGradeChangedData,
} from "./schema.js";

/**
 * @deprecated Use `LargeTradesInsertedData`; renamed in #16304. The two event
 * spellings are one event with one payload, so this is an alias.
 */
export type WhaleTradesInsertedData = LargeTradesInsertedData;

/**
 * @deprecated Use `TraderSyncedData`; renamed in #16304. The two event
 * spellings are one event with one payload, so this is an alias.
 */
export type WhaleTraderSyncedData = TraderSyncedData;

/**
 * @deprecated Use `SuspiciousTradeFlaggedData`; renamed in #16301. The two
 * event spellings are one event with one payload, so this is an alias.
 */
export type InsiderRadarFlagRaisedData = SuspiciousTradeFlaggedData;

/**
 * @deprecated Use `SharpMoneyFlowDetectedData`; renamed in #16308. The two
 * event spellings are one event with one payload, so this is an alias.
 */
export type SmartMoneyFlowDetectedData = SharpMoneyFlowDetectedData;

/** One event type's delivery: the envelope around the payload the document declares for it. */
type EventFor<TType extends WebhookEventType> = WebhookEventEnvelope<
  TType,
  WebhookEventData[TType]
>;

/**
 * One large trade per delivery (Pro and Max, #16149). The envelope `id` equals
 * `data.event_id`, and `created_at` is the trade's fill time
 * (`data.traded_at`), not the time the delivery was queued.
 */
export type LargeTradeInsertedV2Event = EventFor<"large_trade_inserted_v2">;
export type LargeTradesInsertedEvent = EventFor<"large_trades_inserted">;
/**
 * @deprecated Use `LargeTradesInsertedEvent`; renamed in #16304. This stays a
 * distinct envelope rather than an alias of it because the delivered `type`
 * discriminant is the spelling the endpoint registered: an endpoint subscribed
 * to `whale_trades_inserted` keeps receiving that literal, so narrowing on it
 * keeps working.
 */
export type WhaleTradesInsertedEvent = EventFor<"whale_trades_inserted">;
export type LiveSportsUpdatedEvent = EventFor<"live_sports_updated">;
export type TraderSyncedEvent = EventFor<"trader_synced">;
/**
 * @deprecated Use `TraderSyncedEvent`; renamed in #16304. This stays a
 * distinct envelope rather than an alias of it because the delivered `type`
 * discriminant is the spelling the endpoint registered: an endpoint subscribed
 * to `whale_trader_synced` keeps receiving that literal, so narrowing on it
 * keeps working.
 */
export type WhaleTraderSyncedEvent = EventFor<"whale_trader_synced">;
export type LargePositionsUpdatedEvent = EventFor<"large_positions_updated">;
export type WalletGradeChangedEvent = EventFor<"wallet_grade_changed">;
export type SuspiciousTradeFlaggedEvent = EventFor<"suspicious_trade_flagged">;
/**
 * @deprecated Use `SuspiciousTradeFlaggedEvent`; renamed in #16301. This stays
 * a distinct envelope rather than an alias of it because the delivered `type`
 * discriminant is the spelling the endpoint registered: an endpoint subscribed
 * to `insider_radar_flag_raised` keeps receiving that literal, so narrowing on
 * it keeps working.
 */
export type InsiderRadarFlagRaisedEvent = EventFor<"insider_radar_flag_raised">;
export type SharpMoneyFlowDetectedEvent = EventFor<"sharp_money_flow_detected">;
/**
 * @deprecated Use `SharpMoneyFlowDetectedEvent`; renamed in #16308. This stays
 * a distinct envelope rather than an alias of it because the delivered `type`
 * discriminant is the spelling the endpoint registered: an endpoint subscribed
 * to `smart_money_flow_detected` keeps receiving that literal, so narrowing on
 * it keeps working.
 */
export type SmartMoneyFlowDetectedEvent = EventFor<"smart_money_flow_detected">;
export type ExportJobReadyEvent = EventFor<"export_job_ready">;
export type ExportJobFailedEvent = EventFor<"export_job_failed">;
export type ExportJobExpiredEvent = EventFor<"export_job_expired">;
export type ExportJobCancelledEvent = EventFor<"export_job_cancelled">;

/**
 * Discriminated union over every typed webhook delivery payload.
 *
 * `SuspiciousTradeFlaggedEvent` and `InsiderRadarFlagRaisedEvent` are both
 * members because the same event is delivered under whichever spelling the
 * endpoint registered (#16301); the `data` shape is identical. So are
 * `SharpMoneyFlowDetectedEvent` and `SmartMoneyFlowDetectedEvent` (#16308),
 * `LargeTradesInsertedEvent` and `WhaleTradesInsertedEvent`, and
 * `TraderSyncedEvent` and `WhaleTraderSyncedEvent` (#16304).
 *
 * One member for every name in `WEBHOOK_EVENT_TYPES`; the `satisfies` on that
 * list fails to compile when a name has none.
 */
export type WebhookEvent =
  | LargeTradeInsertedV2Event
  | LargeTradesInsertedEvent
  | WhaleTradesInsertedEvent
  | LiveSportsUpdatedEvent
  | TraderSyncedEvent
  | WhaleTraderSyncedEvent
  | LargePositionsUpdatedEvent
  | WalletGradeChangedEvent
  | SuspiciousTradeFlaggedEvent
  | InsiderRadarFlagRaisedEvent
  | SharpMoneyFlowDetectedEvent
  | SmartMoneyFlowDetectedEvent
  | ExportJobReadyEvent
  | ExportJobFailedEvent
  | ExportJobExpiredEvent
  | ExportJobCancelledEvent;

/**
 * Parse a verified raw body into the typed delivery envelope. Call only AFTER
 * `verifySignature` passes (parsing first would let an unverified payload in).
 */
export function parseWebhookEvent(body: string): WebhookEvent {
  return JSON.parse(body) as WebhookEvent;
}
