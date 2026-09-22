/**
 * Typed error hierarchy for the 0xinsider API V1 error envelope.
 *
 * The V1 contract returns a stable error shape on every non-2xx response
 * (`web/public/api/v1/openapi.json` -> components.schemas.ApiError):
 *
 *   {
 *     "object": "error",
 *     "error": { "code": <ApiErrorCode>, "message": string, "doc_url"?, "param"? },
 *     "meta":  { "request_id": string, "cached": boolean, "cost": number, ... }
 *   }
 *
 * Some upstream/proxy failures return a flat body `{ code, message }` without
 * the `object: "error"` wrapper; both shapes are normalized here.
 *
 * The canonical `code` set is the `ApiError.error.code` enum in the OpenAPI
 * spec. The client maps each error to the most specific subclass -- dispatching on `reason` first (it is strictly more specific), then `code` so callers can
 * `instanceof` the specific failure, and falls back to the base
 * `OxinsiderApiError` for unknown codes or non-JSON bodies.
 */

/**
 * Canonical error codes the API can return. Source of truth:
 * `components.schemas.ApiError.properties.error.properties.code.enum`.
 */
export const API_ERROR_CODES = [
  "bad_request",
  "invalid_api_key",
  "subscription_required",
  "forbidden",
  "not_found",
  "account_locked",
  "rate_limited",
  "rate_limit_unavailable",
  "internal_error",
  // 403 (#13689): an OAuth token that lacks the scope this route needs.
  "insufficient_scope",
  // 408 (#16146): the handler did not answer inside the server's 30-second
  // timeout. Dispatched to ServerTimeoutError below.
  "request_timeout",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * The specific, actionable cause behind a `code`. Source of truth:
 * `components.schemas.ApiError.properties.error.properties.reason.enum`.
 *
 * Additive (#7209): `code` keeps its published values, so this never changes what
 * an existing `code` means. It tells you what to DO, where the code alone could
 * not: `pick_not_released` is "not YET" (sleep until `retryAt`), not "does not
 * exist"; `unknown_endpoint` is a wrong PATH (do not retry); `trader_not_tracked`
 * is a wallet we do not capture (stop asking for it); `cursor_expired` means
 * re-request page 1; `read_model_warming` is endpoint-local unavailability,
 * not rate limiting. Retry only that route after the supplied interval; do not
 * infer dependency health from the reason.
 */
export const API_ERROR_REASONS = [
  "cursor_expired",
  "unknown_endpoint",
  "pick_not_released",
  "trader_not_tracked",
  "read_model_warming",
  "database_unavailable",
  "request_accounting_unavailable",
  // 409 conflict causes (code `bad_request` at HTTP 409): the same mutation is
  // still running / a webhook endpoint is mid-delivery. Dispatched to
  // IdempotencyInProgressError / WebhookDeliveryInProgressError below, both
  // refining BadRequestError to match the wire code.
  "idempotency_in_progress",
  "webhook_delivery_in_progress",
  // Staged webhook rotation state: prepare before activate, and retire the
  // bounded overlap before starting another staged rotation.
  "webhook_secret_rotation_not_prepared",
  "webhook_secret_rotation_overlap_active",
  // 401 `invalid_api_key` refinement (#13959): a sandbox key sent to the live
  // API. Dispatched to SandboxApiKeyError below.
  "sandbox_api_key",
  // 401 `invalid_api_key` refinement (#14123): the key was sent as a `?token=`
  // query parameter, which no route reads. Dispatched to ApiKeyInQueryError.
  "api_key_in_query",
  // 402 `subscription_required` refinement (#14283): the account's Pro
  // subscription has lapsed. Permanent until a person reactivates; the
  // message names the URL. Carried on SubscriptionRequiredError.reason.
  "subscription_inactive",
  // 429 `rate_limited` refinement (#16111): the account has used the requests
  // Pro includes for the UTC calendar month. `retry_at` is the first of next
  // month; pay as you go is turned on at https://0xinsider.com/developers.
  "monthly_quota_exceeded",
  // 400 `bad_request` refinements (#16146): the request never reached a
  // handler because a query parameter, a path segment or the JSON body did
  // not parse or did not fit the route's schema; `param` names the field
  // when the server named one. Fix the request; never retry it as sent.
  "invalid_query",
  // 400 `bad_request` refinement (#16189): strict query validation rejected a
  // name the operation does not publish before the handler ran.
  "unknown_query_parameter",
  "invalid_path",
  "invalid_body",
  // 415, 413 and 405 under `bad_request` (#16146): send the body as
  // `Content-Type: application/json`; keep it under 1 MiB; use a method the
  // path serves (`Allow` names them). All three arrive as BadRequestError
  // with `reason` set.
  "unsupported_media_type",
  "payload_too_large",
  "method_not_allowed",
  // 429 `rate_limited` refinements (#16380): the per-address budget shared by
  // every caller behind one IP (`ip_rate_limited`; the RateLimit-* headers
  // describe that bucket, not the key's), and an address cooldown after
  // sustained over-limit traffic (`ip_throttled`; Retry-After is minutes to
  // days and an earlier retry extends it). Both arrive as RateLimitedError
  // with `reason` set; sleep `retryAfterSeconds` either way.
  "ip_rate_limited",
  "ip_throttled",
] as const;

export type ApiErrorReason = (typeof API_ERROR_REASONS)[number];

/** Parsed `error` object from the V1 error envelope. */
export interface ApiErrorBody {
  code?: string;
  message?: string;
  doc_url?: string | null;
  param?: string | null;
  /** The specific cause behind `code`, when there is a more specific one (#7209). */
  reason?: string | null;
  /** RFC3339 instant before which retrying cannot succeed (#7209). Always future. */
  retry_at?: string | null;
  [key: string]: unknown;
}

/** Response `meta` carried alongside an error envelope. */
export interface ApiErrorMeta {
  request_id?: string;
  cached?: boolean;
  cost?: number;
  [key: string]: unknown;
}

/**
 * The request missed its deadline (`timeoutMs`) before any response arrived.
 * Not an `OxinsiderApiError`: there is no status, body, or request id. Retry
 * with backoff; a persistent timeout is a network or service problem, not a
 * rejected request (#11115).
 */
export class RequestTimeoutError extends Error {
  readonly operationId: string;
  readonly timeoutMs: number;

  constructor(operationId: string, timeoutMs: number) {
    super(
      `0xinsider API ${operationId} did not answer within ${String(timeoutMs)} ms`,
    );
    this.name = "RequestTimeoutError";
    this.operationId = operationId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Base class for every error thrown by the SDK on a non-2xx API response.
 * Subclasses below specialize by documented `code`.
 */
export class OxinsiderApiError extends Error {
  /** HTTP status code of the failing response. */
  readonly status: number;
  /** Documented error code, when the body carried one. */
  readonly code: ApiErrorCode | string | undefined;
  /**
   * The specific, actionable cause behind `code`, or `null` when the response carried
   * no reason the SDK recognizes (#7209).
   *
   * Declared on the BASE class, not only on the five reason subclasses, so the thing an
   * SDK user actually writes type-checks:
   *
   *   catch (e) { if (e instanceof OxinsiderApiError && e.reason === "pick_not_released") ... }
   *
   * With `reason` living only on the subclasses, that read was a type error, and the only
   * way to branch on the cause was an `instanceof` ladder over all five -- which defeats
   * the point of shipping a reason at all. The subclasses narrow this to their own literal.
   *
   * The raw wire value always stays on `error.reason`, so a reason NEWER than this SDK is
   * never destroyed -- it is simply not typed yet, and reads as `null` here.
   */
  readonly reason: ApiErrorReason | null = null;
  /**
   * When retrying can first succeed, or `null` when the error is terminal.
   *
   * On the BASE class for exactly the reason `reason` is, and the backend says so in its
   * own contract (`ApiErrorBody::retry_at`): the field is "generic on purpose ... so
   * clients key on ONE field across the whole API rather than a per-endpoint zoo". With
   * `retryAt` living only on the three retryable subclasses,
   *
   *   catch (e) { if (e instanceof OxinsiderApiError && e.retryAt) scheduleRetry(e.retryAt) }
   *
   * was a type error -- the same defect the `reason` hoist above exists to fix, left in
   * place one field over.
   *
   * Parsed from the wire on every error, so it is present whenever the API sends it and
   * `null` when it does not. A terminal error (`cursor_expired`, `trader_not_tracked`)
   * has no `retry_at`, and `null` is the honest answer: do not retry this.
   *
   * DO NOT BLOCK A WORKER THREAD ON IT. On `pick_not_released` this can be 13-14 hours
   * out (a full day on a skipped day). Schedule the retry; do not sleep.
   */
  readonly retryAt: Date | null;
  /** Parsed `error` object (`{ code, message, doc_url?, param? }`), or null. */
  readonly error: ApiErrorBody | null;
  /** Response `meta` (`request_id`, `cost`, ...), or null. */
  readonly meta: ApiErrorMeta | null;
  /** The `request_id` from `meta`, surfaced for support correlation. */
  readonly requestId: string | undefined;
  /** Raw, unparsed body for debugging. */
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const error = extractApiErrorBody(body);
    const meta = extractApiErrorMeta(body);
    const message =
      error?.message ??
      `0xinsider API request failed with status ${String(status)}`;
    super(message);
    this.name = "OxinsiderApiError";
    this.status = status;
    this.code = error?.code;
    this.error = error;
    this.meta = meta;
    this.requestId = meta?.request_id;
    this.body = body;
    // Parsed once, here, for EVERY error. The retryable subclasses no longer parse it
    // themselves -- two parsers for one wire field is how they drift.
    this.retryAt = parseRetryAt(body);
  }
}

/** 400 - the request was malformed; see `param` for the offending field. */
export class BadRequestError extends OxinsiderApiError {
  override readonly code = "bad_request" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "BadRequestError";
  }
}

/**
 * 400 `reason: unknown_query_parameter` - strict validation rejected a query
 * name the operation does not publish. Remove or correct the name, or leave
 * `strictQuery` unset while migrating a caller.
 */
export class UnknownQueryParameterError extends BadRequestError {
  override readonly reason = "unknown_query_parameter" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "UnknownQueryParameterError";
  }
}

/** 401 - the `oxi_sk_*` API key is missing, malformed, or revoked. */
export class InvalidApiKeyError extends OxinsiderApiError {
  override readonly code = "invalid_api_key" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "InvalidApiKeyError";
  }
}

/**
 * 401 `reason: sandbox_api_key` - the credential is a sandbox key (`oxi_sk_test_`)
 * from `POST /api/v1/agents/register` (#13959). Only the sandbox server accepts
 * it: call `https://0xinsider.com/sandbox/api/v1` with it, or use a live key or
 * OAuth access token. Retrying here will not help.
 */
export class SandboxApiKeyError extends InvalidApiKeyError {
  override readonly reason = "sandbox_api_key" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "SandboxApiKeyError";
  }
}

/**
 * 401 `reason: api_key_in_query` - the key was sent as a `?token=` query
 * parameter (#14123). No route reads a key from the URL, so the key itself was
 * not checked: resend it as `Authorization: Bearer`. This client always sends
 * the header, so seeing this means a URL was built by hand.
 */
export class ApiKeyInQueryError extends InvalidApiKeyError {
  override readonly reason = "api_key_in_query" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "ApiKeyInQueryError";
  }
}

/**
 * 402 - the key is valid but the account has no active Pro subscription.
 *
 * Permanent until a person reactivates (`reason: subscription_inactive`,
 * #14283): there is no `Retry-After`, and a retry on a schedule never clears
 * it. Stop the loop and surface `reactivationUrl` to your own user. The key
 * and its settings are unchanged and work again the moment Pro is active;
 * the owner is emailed once per lapse.
 */
export class SubscriptionRequiredError extends OxinsiderApiError {
  override readonly code = "subscription_required" as const;
  /** Where the account reactivates Pro. */
  readonly reactivationUrl = "https://0xinsider.com/billing";
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "SubscriptionRequiredError";
  }
}

/** 403 - the key is authenticated but not allowed to access this resource. */
export class ForbiddenError extends OxinsiderApiError {
  override readonly code = "forbidden" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "ForbiddenError";
  }
}

/** 404 - the requested resource does not exist. */
export class NotFoundError extends OxinsiderApiError {
  override readonly code = "not_found" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "NotFoundError";
  }
}

/** 403 - the account is locked; contact support. */
export class AccountLockedError extends OxinsiderApiError {
  override readonly code = "account_locked" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "AccountLockedError";
  }
}

/**
 * 429 - the per-key rate limit was exceeded. `retryAfterSeconds` is read from
 * the standard `Retry-After` response header when present.
 */
export class RateLimitedError extends OxinsiderApiError {
  override readonly code = "rate_limited" as const;
  /** Seconds to wait before retrying, from the `Retry-After` header. */
  readonly retryAfterSeconds: number | null;
  constructor(status: number, body: unknown, retryAfterSeconds: number | null) {
    super(status, body);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * 408 `request_timeout` (#16146) - the server did not finish the request
 * inside its 30-second timeout. Distinct from `RequestTimeoutError`, which is
 * this client's own deadline with no response at all.
 *
 * `retryAfterSeconds` is set only on a safe method (GET, HEAD): the server
 * gives a mutation no hint, because it may have completed. Check its state
 * before repeating it, and reuse its Idempotency-Key.
 */
export class ServerTimeoutError extends OxinsiderApiError {
  override readonly code = "request_timeout" as const;
  /** Seconds to wait before retrying a safe read, from `Retry-After`; null on a mutation. */
  readonly retryAfterSeconds: number | null;
  constructor(status: number, body: unknown, retryAfterSeconds: number | null) {
    super(status, body);
    this.name = "ServerTimeoutError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 503 - the rate-limit/admission backend was briefly unavailable; retry. */
export class RateLimitUnavailableError extends OxinsiderApiError {
  override readonly code = "rate_limit_unavailable" as const;
  /** Seconds to wait before retrying, from the `Retry-After` header. */
  readonly retryAfterSeconds: number | null;
  constructor(status: number, body: unknown, retryAfterSeconds: number | null) {
    super(status, body);
    this.name = "RateLimitUnavailableError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * 404 `reason: pick_not_released` - no Pick of the Day is published for the
 * current product day (#7209).
 *
 * This is NOT "the endpoint is broken" and NOT "the resource does not exist".
 * Each selected pick releases about an hour before its own provider kickoff, inside
 * the daily operating window, 11:00 UTC to 23:00 America/New_York (#7226, #7709,
 * #16207) -- there is no fixed publish clock time. The product day rolls at midnight America/New_York, so the
 * endpoint legitimately 404s from that roll until the day's release (a span that
 * varies with the pick's kickoff), and for the full product day on a skipped day.
 *
 * DO NOT POLL. Sleep for `retryAfterSeconds` (or until `retryAt`) and request
 * once. Blind polling through this window was 91.8% of all logged v1 API errors.
 */
export class PickNotReleasedError extends NotFoundError {
  override readonly reason = "pick_not_released" as const;
  /** Seconds to wait, from `Retry-After`. Prefer this: it is clock-skew immune. */
  readonly retryAfterSeconds: number | null;
  constructor(status: number, body: unknown, retryAfterSeconds: number | null) {
    super(status, body);
    this.name = "PickNotReleasedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * 503 `reason: read_model_warming` - endpoint-local read-model unavailability (#7209).
 *
 * This is not rate limiting. Retry only this route after the supplied interval;
 * the exact cause is endpoint-specific, so do not infer dependency health from
 * this reason.
 */
export class ReadModelWarmingError extends RateLimitUnavailableError {
  override readonly reason = "read_model_warming" as const;
  constructor(status: number, body: unknown, retryAfterSeconds: number | null) {
    super(status, body, retryAfterSeconds);
    this.name = "ReadModelWarmingError";
  }
}

/**
 * 503 `reason: database_unavailable` - the API's database or its connection
 * pool is temporarily unreachable (#10737). A connection-class failure, not a
 * query fault, and not rate limiting: back off for `retryAfterSeconds`, then
 * retry the same request.
 */
export class DatabaseUnavailableError extends RateLimitUnavailableError {
  override readonly reason = "database_unavailable" as const;
  constructor(status: number, body: unknown, retryAfterSeconds: number | null) {
    super(status, body, retryAfterSeconds);
    this.name = "DatabaseUnavailableError";
  }
}

/** 503 - accounting capacity was unavailable before the handler ran. */
export class RequestAccountingUnavailableError extends RateLimitUnavailableError {
  override readonly reason = "request_accounting_unavailable" as const;
  constructor(status: number, body: unknown, retryAfterSeconds: number | null) {
    super(status, body, retryAfterSeconds);
    this.name = "RequestAccountingUnavailableError";
  }
}

/**
 * 400 `reason: cursor_expired` - the pagination cursor was invalidated by an
 * upstream data change (#7209). Recovery is mechanical: re-request the first page
 * and continue. This is NOT a bad parameter -- do not stop retrying.
 */
export class CursorExpiredError extends BadRequestError {
  override readonly reason = "cursor_expired" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "CursorExpiredError";
  }
}

/**
 * 409 `reason: idempotency_in_progress` - the same idempotent mutation is still
 * running. Retain the exact `Idempotency-Key` and body and retry shortly; do NOT
 * mint a new mutation. The wire carries code `bad_request` at HTTP 409, so this
 * refines `BadRequestError` -- a consumer catching `BadRequestError` still matches.
 */
export class IdempotencyInProgressError extends BadRequestError {
  override readonly reason = "idempotency_in_progress" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "IdempotencyInProgressError";
  }
}

/**
 * 409 `reason: webhook_delivery_in_progress` - a webhook endpoint's URL and
 * signing secret are frozen while a delivery is in flight. Retry the
 * configuration change after that delivery completes. The wire carries code
 * `bad_request` at HTTP 409, so this refines `BadRequestError`.
 */
export class WebhookDeliveryInProgressError extends BadRequestError {
  override readonly reason = "webhook_delivery_in_progress" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "WebhookDeliveryInProgressError";
  }
}

/**
 * 404 `reason: unknown_endpoint` - the PATH is not a route on this API (#7209).
 * Read `GET /api/v1` for the route index. Retrying will not help.
 */
export class UnknownEndpointError extends NotFoundError {
  override readonly reason = "unknown_endpoint" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "UnknownEndpointError";
  }
}

/**
 * 404 `reason: trader_not_tracked` - the wallet is real and the URL is right, but
 * the trader is outside the HOT/WARM sync tiers so we do not capture this data
 * for them (#7209). Stop asking for this wallet; do not hunt for a different URL.
 */
export class TraderNotTrackedError extends NotFoundError {
  override readonly reason = "trader_not_tracked" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "TraderNotTrackedError";
  }
}

/** Parse the RFC3339 `error.retry_at` off an error envelope, if present. */
function parseRetryAt(body: unknown): Date | null {
  const raw = extractApiErrorBody(body)?.retry_at;
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A 2xx response whose body does not match the contract this client relies
 * on (#16246): a list operation answering without a list envelope, or with a
 * `has_more` that is not a boolean or a `next_cursor` that is not a string.
 * `code` is `invalid_response`, a client-side code that the API never sends;
 * `received` is the body as parsed. Not retried: the same request would
 * return the same body. Report it with `requestId` when the body carried one.
 */
export class InvalidResponseError extends OxinsiderApiError {
  override readonly code = "invalid_response" as const;
  /** The response body as received, for diagnosis. */
  readonly received: unknown;
  constructor(status: number, message: string, received: unknown) {
    super(status, {
      object: "error",
      error: { code: "invalid_response", message },
      ...(typeof received === "object" &&
      received !== null &&
      "meta" in received
        ? { meta: (received as { meta: unknown }).meta }
        : {}),
    });
    this.name = "InvalidResponseError";
    this.received = received;
  }
}

/** 5xx - an unexpected server-side error; safe to retry with backoff. */
export class InternalServerError extends OxinsiderApiError {
  override readonly code = "internal_error" as const;
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "InternalServerError";
  }
}

/**
 * Construct the most specific `OxinsiderApiError` subclass for a failed
 * response. Dispatch is by `error.reason` FIRST -- strictly more specific than the code,
 * because the reason names the CAUSE where the code names only the class -- then by
 * `error.code`, then a status-code heuristic, falling back to the base class for anything
 * unrecognized so an unknown code is never silently dropped.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  retryAfterSeconds: number | null = null,
): OxinsiderApiError {
  const parsed = extractApiErrorBody(body);
  const code = parsed?.code;

  // `reason` first: it is strictly more specific than `code` (#7209), and it is
  // what carries the actionable distinction -- "not yet" vs "does not exist",
  // "warming" vs "rate limiter down". Falling through to `code` here is what made
  // the SDK re-assert the very lie the backend removed.
  switch (parsed?.reason) {
    case "pick_not_released":
      return new PickNotReleasedError(status, body, retryAfterSeconds);
    case "read_model_warming":
      return new ReadModelWarmingError(status, body, retryAfterSeconds);
    case "request_accounting_unavailable":
      return new RequestAccountingUnavailableError(status, body, retryAfterSeconds);
    case "database_unavailable":
      return new DatabaseUnavailableError(status, body, retryAfterSeconds);
    case "cursor_expired":
      return new CursorExpiredError(status, body);
    case "unknown_endpoint":
      return new UnknownEndpointError(status, body);
    case "trader_not_tracked":
      return new TraderNotTrackedError(status, body);
    case "idempotency_in_progress":
      return new IdempotencyInProgressError(status, body);
    case "webhook_delivery_in_progress":
      return new WebhookDeliveryInProgressError(status, body);
    case "sandbox_api_key":
      return new SandboxApiKeyError(status, body);
    case "api_key_in_query":
      return new ApiKeyInQueryError(status, body);
    case "unknown_query_parameter":
      return new UnknownQueryParameterError(status, body);
    default:
      break;
  }

  switch (code) {
    case "bad_request":
      return new BadRequestError(status, body);
    case "invalid_api_key":
      return new InvalidApiKeyError(status, body);
    case "subscription_required":
      return new SubscriptionRequiredError(status, body);
    case "forbidden":
      return new ForbiddenError(status, body);
    case "not_found":
      return new NotFoundError(status, body);
    case "account_locked":
      return new AccountLockedError(status, body);
    case "rate_limited":
      return new RateLimitedError(status, body, retryAfterSeconds);
    case "rate_limit_unavailable":
      return new RateLimitUnavailableError(status, body, retryAfterSeconds);
    case "request_timeout":
      return new ServerTimeoutError(status, body, retryAfterSeconds);
    case "internal_error":
      return new InternalServerError(status, body);
    default:
      break;
  }

  // No (or unknown) error code: dispatch on the HTTP status so common
  // failures still arrive as the expected subclass.
  switch (status) {
    case 400:
      return new BadRequestError(status, body);
    case 401:
      return new InvalidApiKeyError(status, body);
    case 402:
      return new SubscriptionRequiredError(status, body);
    case 404:
      return new NotFoundError(status, body);
    case 408:
      return new ServerTimeoutError(status, body, retryAfterSeconds);
    case 429:
      return new RateLimitedError(status, body, retryAfterSeconds);
    case 503:
      return new RateLimitUnavailableError(status, body, retryAfterSeconds);
    default:
      if (status >= 500) {
        return new InternalServerError(status, body);
      }
      return new OxinsiderApiError(status, body);
  }
}

/** Pull the `error` object out of an envelope or a flat error body. */
export function extractApiErrorBody(body: unknown): ApiErrorBody | null {
  if (!body || typeof body !== "object") return null;
  if (
    "object" in body &&
    (body as { object?: unknown }).object === "error" &&
    "error" in body &&
    isApiErrorBody((body as { error?: unknown }).error)
  ) {
    return (body as { error: ApiErrorBody }).error;
  }
  if (isApiErrorBody(body) && typeof (body as ApiErrorBody).code === "string") {
    return body as ApiErrorBody;
  }
  return null;
}

function extractApiErrorMeta(body: unknown): ApiErrorMeta | null {
  if (!body || typeof body !== "object") return null;
  if ("meta" in body) {
    const meta = (body as { meta?: unknown }).meta;
    if (meta && typeof meta === "object") {
      return meta as ApiErrorMeta;
    }
  }
  return null;
}

function isApiErrorBody(body: unknown): body is ApiErrorBody {
  return typeof body === "object" && body !== null;
}
