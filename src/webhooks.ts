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
 * `web/public/api/v1/openapi.json` -> components.schemas.WebhookEventType.enum.
 * `large_trades_inserted`, `whale_trades_inserted`, `wallet_grade_changed`,
 * `suspicious_trade_flagged`, `insider_radar_flag_raised`,
 * `sharp_money_flow_detected`, and `smart_money_flow_detected` are Pro-only:
 * they deliver only to API keys on an active Pro subscription.
 *
 * Some entries are two spellings of ONE event, not two events: either one
 * subscribes, and an endpoint receives its deliveries under the spelling it
 * registered. The canonical spelling is listed first of each pair --
 * `large_trades_inserted` over `whale_trades_inserted` and `trader_synced`
 * over `whale_trader_synced` (#16304), `suspicious_trade_flagged` over
 * `insider_radar_flag_raised` (#16301), and `sharp_money_flow_detected` over
 * `smart_money_flow_detected` (#16308). No deprecated spelling is ever
 * removed.
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
  // Pro-only. `sharp_money_flow_detected` is the canonical spelling since
  // #16308 ("sharp money" is the pinned product term);
  // `smart_money_flow_detected` is its deprecated twin, kept live, and stays
  // the `type` an endpoint that registered it receives.
  "sharp_money_flow_detected",
  "smart_money_flow_detected",
  "export_job_ready",
  "export_job_failed",
  "export_job_expired",
  "export_job_cancelled",
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

/** One side's score line inside a `live_sports_updated` pulse. */
export interface LiveSportsScoreEntry {
  team: string;
  score: string;
  /** Esports series only: this side's current-map score. Absent on other sports. */
  map_score?: string;
}

/**
 * `live_sports_updated` data: one bounded pulse for one live game.
 *
 * A pulse fires when a material field moved since this game's previous
 * delivered pulse (`scores`, `status`, `period`, `live`, `ended`), at most once
 * per game per 20 seconds. A `live` or `ended` transition is exempt from that
 * interval, so a game going live or final is never coalesced away; the game
 * clock alone never fires a pulse. Suppressed frames are folded into the next
 * pulse's `changed` and its body carries the current state, so you see every
 * field that moved but not every intermediate value.
 */
export interface LiveSportsUpdatedData {
  /** The Polymarket event slug this game trades under. */
  event_slug: string;
  /** Provider game id, or `null` when the frame carried none. */
  game_id: string | null;
  /** League abbreviation, or `null`. */
  league: string | null;
  /**
   * Durable per-game pulse ordinal, increasing by one per delivered pulse.
   * Deliveries are not ordered, so drop a pulse whose version you already saw.
   */
  version: number;
  /** Material fields that moved since this game's previous delivered pulse. */
  changed: Array<"scores" | "status" | "period" | "live" | "ended">;
  /** Provider frame time (ISO 8601), or `null` when the frame carried none. */
  observed_at: string | null;
  /** When the pulse was admitted (ISO 8601). */
  published_at: string;
  status: string | null;
  period: string | null;
  /** Game clock. Not a material field: it never fires a pulse on its own. */
  clock: string | null;
  live: boolean | null;
  ended: boolean;
  scores: LiveSportsScoreEntry[];
  /** Esports `BoN` series token, or `null` on every other sport. */
  series_format: string | null;
  /** Public game page; re-read it after a gap instead of replaying pulses. */
  snapshot_url: string;
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
 * `suspicious_trade_flagged` data (Pro-only): a suspicion threshold was
 * crossed on a fresh fill. Source: `backend/src/polymarket_rtds_ingest/flushing.rs`.
 *
 * Delivered identically under the deprecated spelling
 * `insider_radar_flag_raised` (#16301) to an endpoint that registered that
 * spelling; the payload is the same.
 */
export interface SuspiciousTradeFlaggedData {
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
 * @deprecated Use `SuspiciousTradeFlaggedData`; renamed in #16301. The two
 * event spellings are one event with one payload, so this is an alias.
 */
export type InsiderRadarFlagRaisedData = SuspiciousTradeFlaggedData;

/**
 * `sharp_money_flow_detected` payload (Pro-only). Fires when a scheduled
 * scanner detects ranked-trader net flow crossing a threshold on a market.
 *
 * One payload for both spellings of the event: the deprecated
 * `smart_money_flow_detected` delivers the same object (#16308).
 */
export interface SharpMoneyFlowDetectedData {
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

/** `export_job_ready` data: the owner's async export can be downloaded. */
export interface ExportJobReadyData {
  job_id: number;
  status: "ready";
  format: string;
  next_action: "download";
  total_trades: number | null;
  processed_trades: number | null;
  file_size: number | null;
  data_as_of: string | null;
}

/** `export_job_failed` data: the owner's async export reached a terminal failure. */
export interface ExportJobFailedData {
  job_id: number;
  status: "failed";
  format: string;
  next_action: "resubmit";
  failure_reason: string;
}

/** `export_job_expired` data: the owner's ready export passed retention. */
export interface ExportJobExpiredData {
  job_id: number;
  status: "expired";
  format: string;
  next_action: "resubmit";
}

/** `export_job_cancelled` data: the owner's export stopped because its owner cancelled it. */
export interface ExportJobCancelledData {
  job_id: number;
  status: "cancelled";
  format: string;
  next_action: "resubmit";
}

export type WhaleTradesInsertedEvent = WebhookEventEnvelope<
  "whale_trades_inserted",
  WhaleTradesInsertedData
>;
export type LiveSportsUpdatedEvent = WebhookEventEnvelope<
  "live_sports_updated",
  LiveSportsUpdatedData
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
export type SuspiciousTradeFlaggedEvent = WebhookEventEnvelope<
  "suspicious_trade_flagged",
  SuspiciousTradeFlaggedData
>;
/**
 * @deprecated Use `SuspiciousTradeFlaggedEvent`; renamed in #16301. This stays
 * a distinct envelope rather than an alias of it because the delivered `type`
 * discriminant is the spelling the endpoint registered: an endpoint subscribed
 * to `insider_radar_flag_raised` keeps receiving that literal, so narrowing on
 * it keeps working.
 */
export type InsiderRadarFlagRaisedEvent = WebhookEventEnvelope<
  "insider_radar_flag_raised",
  SuspiciousTradeFlaggedData
>;
/**
 * @deprecated Use `SharpMoneyFlowDetectedData`; renamed in #16308. The two
 * event spellings are one event with one payload, so this is an alias.
 */
export type SmartMoneyFlowDetectedData = SharpMoneyFlowDetectedData;

export type SharpMoneyFlowDetectedEvent = WebhookEventEnvelope<
  "sharp_money_flow_detected",
  SharpMoneyFlowDetectedData
>;
/**
 * @deprecated Use `SharpMoneyFlowDetectedEvent`; renamed in #16308. This stays
 * a distinct envelope rather than an alias of it because the delivered `type`
 * discriminant is the spelling the endpoint registered: an endpoint subscribed
 * to `smart_money_flow_detected` keeps receiving that literal, so narrowing on
 * it keeps working.
 */
export type SmartMoneyFlowDetectedEvent = WebhookEventEnvelope<
  "smart_money_flow_detected",
  SharpMoneyFlowDetectedData
>;
export type ExportJobReadyEvent = WebhookEventEnvelope<"export_job_ready", ExportJobReadyData>;
export type ExportJobFailedEvent = WebhookEventEnvelope<"export_job_failed", ExportJobFailedData>;
export type ExportJobExpiredEvent = WebhookEventEnvelope<"export_job_expired", ExportJobExpiredData>;
export type ExportJobCancelledEvent = WebhookEventEnvelope<
  "export_job_cancelled",
  ExportJobCancelledData
>;

/**
 * Discriminated union over every typed webhook delivery payload.
 *
 * `SuspiciousTradeFlaggedEvent` and `InsiderRadarFlagRaisedEvent` are both
 * members because the same event is delivered under whichever spelling the
 * endpoint registered (#16301); the `data` shape is identical. So are
 * `SharpMoneyFlowDetectedEvent` and `SmartMoneyFlowDetectedEvent` (#16308).
 */
export type WebhookEvent =
  | WhaleTradesInsertedEvent
  | LiveSportsUpdatedEvent
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
