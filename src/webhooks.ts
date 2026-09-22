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
 * the OpenAPI document:
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
 */

import { createHmac, timingSafeEqual } from "node:crypto";

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
 * Webhook event types. Source of truth:
 * the OpenAPI document -> components.schemas.WebhookEventType.enum.
 * `whale_trades_inserted`, `wallet_grade_changed`, `insider_radar_flag_raised`,
 * and `smart_money_flow_detected` are Pro-only: they deliver only to API keys
 * on an active Pro subscription.
 */
export const WEBHOOK_EVENT_TYPES = [
  "whale_trades_inserted",
  "live_sports_updated",
  "whale_trader_synced",
  "large_positions_updated",
  "wallet_grade_changed",
  "insider_radar_flag_raised",
  // Pro-only; present in the OpenAPI WebhookEventType enum + backend
  // allowlist but previously missing here (drift fix, #6915). The wire
  // identifier stays `smart_money_flow_detected` (frozen event name).
  "smart_money_flow_detected",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/**
 * Common delivery envelope every webhook POST body carries. Source of truth:
 * the `enqueue_webhook_event` call sites in the backend
 * (`{ id, type, created_at, data }`).
 */
export interface WebhookEventEnvelope<
  TType extends WebhookEventType = WebhookEventType,
  TData = unknown,
> {
  /** Stable event id; identical across retries of the same logical event. */
  id: string;
  type: TType;
  /** ISO-8601 timestamp of when the event was enqueued. */
  created_at: string;
  data: TData;
}

/** `whale_trades_inserted` data (Pro-only): a batch of new whale trades was ingested. */
export interface WhaleTradesInsertedData {
  count: number;
}

/** `whale_trader_synced` data: a tracked trader finished a sync pass. */
export interface WhaleTraderSyncedData {
  trader_id: number;
  wallet: string;
}

/** `large_positions_updated` data. */
export interface LargePositionsUpdatedData {
  count: number;
}

/**
 * `wallet_grade_changed` data (Pro-only): a tracked wallet's grade moved.
 * Source: `backend/crates/sync/src/periodic/heavy_pipeline.rs`.
 */
export interface WalletGradeChangedData {
  wallet: string;
  trader_id: number;
  old_grade: string;
  new_grade: string;
  /** Direction of the grade move, e.g. "up" / "down". */
  direction: string;
  skill_index: number;
  final_score: number;
  date: string;
}

/**
 * `insider_radar_flag_raised` data (Pro-only): a suspicion threshold was
 * crossed on a fresh fill. Source: `backend/src/polymarket_rtds_ingest/flushing.rs`.
 */
export interface InsiderRadarFlagRaisedData {
  trade_id: string;
  wallet: string;
  trader_id: number;
  condition_id: string;
  suspicion_score: number;
  track: string;
  /** Outcome side the flagged fill took. */
  side: string;
  size: number;
  price: number;
}

/**
 * `smart_money_flow_detected` payload (Pro-only). Fires when a scheduled
 * scanner detects ranked-trader net flow crossing a threshold on a market.
 */
export interface SmartMoneyFlowDetectedData {
  condition_id: string;
  /** Signed net YES/NO exposure from ranked traders. */
  net_flow_usd: number;
  abs_net_flow_usd: number;
  /** Side the net flow leans: "yes" or "no". */
  dominant_side: string;
  /** Minimum trader grade included: "S", "A", "B", "C", "D", or "F". */
  grade_floor: string;
  whale_trade_count: number;
  /** Detection window, e.g. "24h". */
  window: string;
}

export type WhaleTradesInsertedEvent = WebhookEventEnvelope<
  "whale_trades_inserted",
  WhaleTradesInsertedData
>;
export type WhaleTraderSyncedEvent = WebhookEventEnvelope<
  "whale_trader_synced",
  WhaleTraderSyncedData
>;
export type LargePositionsUpdatedEvent = WebhookEventEnvelope<
  "large_positions_updated",
  LargePositionsUpdatedData
>;
export type WalletGradeChangedEvent = WebhookEventEnvelope<
  "wallet_grade_changed",
  WalletGradeChangedData
>;
export type InsiderRadarFlagRaisedEvent = WebhookEventEnvelope<
  "insider_radar_flag_raised",
  InsiderRadarFlagRaisedData
>;
export type SmartMoneyFlowDetectedEvent = WebhookEventEnvelope<
  "smart_money_flow_detected",
  SmartMoneyFlowDetectedData
>;

/** Discriminated union over every typed webhook delivery payload. */
export type WebhookEvent =
  | WhaleTradesInsertedEvent
  | WhaleTraderSyncedEvent
  | LargePositionsUpdatedEvent
  | WalletGradeChangedEvent
  | InsiderRadarFlagRaisedEvent
  | SmartMoneyFlowDetectedEvent
  | WebhookEventEnvelope<"live_sports_updated", unknown>;

/**
 * Parse a verified raw body into the typed delivery envelope. Call only AFTER
 * `verifySignature` passes (parsing first would let an unverified payload in).
 */
export function parseWebhookEvent(body: string): WebhookEvent {
  return JSON.parse(body) as WebhookEvent;
}
