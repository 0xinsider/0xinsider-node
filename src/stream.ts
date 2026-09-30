/**
 * SSE consumer for `GET /api/v1/stream`.
 *
 * The endpoint forwards the platform's live feed envelopes as Server-Sent
 * Events. Source of truth: `web/public/api/v1/openapi.json` -> paths./api/v1/stream.
 *
 * Wire format (per the spec's response description):
 *   - Each data frame is `id: <seq>\ndata: <json-envelope>\n\n`, where the JSON
 *     envelope is `{ seq, published_at, type, ...event-specific }`. The SSE id
 *     equals the envelope `seq`.
 *   - A resync marker is `event: resync\nid: <seq>\ndata: <json>\n\n`, where the
 *     JSON is `{ type: "resync", completeness, from_sequence, to_sequence }`.
 *     It means the requested resume point is outside the retained window or a
 *     live sequence gap was observed; treat it as "refetch current state".
 *   - Idle connections emit `: keep-alive` comment lines (ignored).
 *
 * Resume is via the `Last-Event-ID` header set to the last `seq` you processed;
 * the spec also accepts `last_event_id` / `seq` query fallbacks. This consumer
 * sends the header and auto-tracks the last seen seq so a caller-driven
 * reconnect resumes from the right place.
 *
 * Filters (per-connection, subscribe-time): `event` (comma-separated frame
 * types), `condition_id`, and `min_grade` (S|A|B|C|D|F).
 *
 * Protocol validity (#16248). The decoder is bounded and fails visibly:
 *   - A successful response whose media type is not `text/event-stream` is
 *     `StreamProtocolError` (`unexpected_media_type`), not an empty stream.
 *   - A data frame whose payload is not JSON, not an object, or has no usable
 *     sequence (a finite `seq` in the envelope, or a finite SSE `id`) is a
 *     `StreamProtocolError` (`invalid_json`, `invalid_envelope`,
 *     `unusable_sequence`); a resync frame whose payload is not an object is
 *     `invalid_resync`. Before #16248 such frames were skipped or yielded with
 *     `NaN`, and the next valid frame moved the cursor past the gap.
 *   - A frame larger than `maxFrameBytes` (default 1 MiB), whether or not its
 *     blank-line delimiter has arrived, is `frame_too_large` before it is
 *     parsed (#16644); the reader is released and the connection closed.
 *   - The error carries `lastSeq`, the last sequence delivered before it, so a
 *     malformed frame never moves the cursor and a caller can decide whether
 *     to resume from there (which replays the frame while it is retained),
 *     skip past `frameId`, or refetch state. No raw payload is on the error.
 *   - A terminal `event: error` frame (the key was revoked, the account
 *     lapsed, or the credential store could not confirm the key) throws the
 *     typed `OxinsiderApiError` it carries and is never yielded (#16546);
 *     `retry: false` is permanent to the resilient consumers.
 *   Comment lines (`: keep-alive`), LF and CRLF framing, unknown SSE fields
 *   and unknown-but-valid envelope `type`s are compatible as before.
 */

import { resolveApiUrl, type Grade, type OxinsiderApiClient } from "./client.js";
import { errorFromResponse, OxinsiderApiError } from "./errors.js";
import {
  RETRY_AFTER_CEILING_MS,
  retryAfterSeconds,
  waitUnlessAborted,
} from "./retry.js";

/** A live feed envelope frame: `{ seq, published_at, type, ...payload }`. */
export interface FeedEnvelope {
  /** Cluster-shared monotonic sequence id; also the SSE event id. */
  seq: number;
  /** ISO-8601 publish time, when present. */
  published_at?: string;
  /** Frame wire type, e.g. `"WhaleTradesInserted"`. */
  type: string;
  [key: string]: unknown;
}

/** A resync marker frame (SSE `event: resync`). */
export interface ResyncMarker {
  type: "resync";
  completeness?: {
    status?: string;
    reason?: string;
    [key: string]: unknown;
  };
  from_sequence?: number;
  to_sequence?: number;
  [key: string]: unknown;
}

export interface StreamFilters {
  /**
   * Subscribe only to these frame wire types. Sent as a comma-separated
   * `event` query param. Empty/omitted = all frames.
   */
  event?: readonly string[];
  /** Subscribe only to frames for this market (raw provider id or `mkt_*`). */
  condition_id?: string;
  /** Only deliver frames carrying a grade at or above this threshold. */
  min_grade?: Grade;
}

export interface StreamOptions extends StreamFilters {
  /**
   * Resume after this cluster-shared sequence id (sets `Last-Event-ID`). It
   * remains valid across replicas and process restarts while retained. When
   * omitted the stream starts from the live head.
   */
  lastEventId?: number | string;
  /** Cooperative cancellation; abort to close the stream. */
  signal?: AbortSignal;
  /** Invoked once for the resync marker frame, if one is emitted. */
  onResync?: (marker: ResyncMarker) => void;
  /**
   * Optional cursor object whose `seq` is updated to the last DELIVERED
   * envelope `seq` as frames arrive. Pass the same object back as
   * `lastEventId: cursor.seq` on reconnect to resume from where you left off.
   *
   * Received, not processed (#16247). It is written before the frame reaches
   * your code, so it says the frame arrived and nothing about whether your
   * handling of it succeeded: resuming from it after a handler failure skips
   * that event. When losing an event would lose work, drive the stream with
   * `consumeStreamCheckpointed`, whose `StreamCheckpoint` advances only after
   * the handler and your durable write resolve, and keep this cursor for
   * transport progress.
   */
  cursor?: { seq?: number };
  /**
   * Byte ceiling for one undelivered frame (#16248). Default
   * `DEFAULT_MAX_STREAM_FRAME_BYTES` (1 MiB). A frame larger than this,
   * delimited or not, ends the connection with `StreamProtocolError`
   * (`frame_too_large`) before it is parsed or yielded, and the reader is
   * released (#16644).
   * A positive finite integer; the largest real frame is a few KB.
   */
  maxFrameBytes?: number;
}

/** Default for `StreamOptions.maxFrameBytes`: 1 MiB. */
export const DEFAULT_MAX_STREAM_FRAME_BYTES = 1_048_576;

/** What the stream did that the SSE contract does not allow. */
export type StreamProtocolErrorReason =
  /** A 2xx whose `Content-Type` is not `text/event-stream`. */
  | "unexpected_media_type"
  /** A data frame whose payload is not JSON. */
  | "invalid_json"
  /** A data frame whose payload is JSON but not an object (or is `null`, an array). */
  | "invalid_envelope"
  /** A data frame with no finite `seq` in the envelope and no finite SSE `id`. */
  | "unusable_sequence"
  /** A resync frame whose payload is not an object, or whose `type` is not `resync`. */
  | "invalid_resync"
  /** A frame, delimited or not, is larger than `maxFrameBytes`. */
  | "frame_too_large";

/**
 * The stream broke the SSE contract (#16248). The connection is closed and
 * the reader released before this is thrown. `lastSeq` is the last sequence
 * delivered on this connection, or `undefined` when none was: no malformed
 * frame moves the cursor. `frameId` is the SSE `id` of the offending frame
 * when it carried one, `event` its SSE event name, `bytes` its size, and
 * `mediaType` the response's `Content-Type` for `unexpected_media_type`. The
 * raw payload is deliberately not carried: it may hold data you would not
 * want in a log, and `frameId` plus `lastSeq` name the frame exactly.
 *
 * `streamFeedResilient` treats this as permanent: reconnecting from
 * `lastSeq` would replay the same frame while the server retains it. Decide:
 * resume from `lastSeq` later, resume after `frameId` to skip it, or refetch
 * state and attach live.
 */
export class StreamProtocolError extends Error {
  readonly reason: StreamProtocolErrorReason;
  readonly lastSeq: number | undefined;
  readonly frameId: number | undefined;
  readonly event: string | undefined;
  readonly bytes: number | undefined;
  readonly mediaType: string | undefined;

  constructor(
    reason: StreamProtocolErrorReason,
    detail: {
      lastSeq: number | undefined;
      frameId?: number;
      event?: string;
      bytes?: number;
      mediaType?: string | null;
    },
  ) {
    super(streamProtocolMessage(reason, detail));
    this.name = "StreamProtocolError";
    this.reason = reason;
    this.lastSeq = detail.lastSeq;
    this.frameId = detail.frameId;
    this.event = detail.event;
    this.bytes = detail.bytes;
    this.mediaType = detail.mediaType ?? undefined;
  }
}

function streamProtocolMessage(
  reason: StreamProtocolErrorReason,
  detail: {
    lastSeq: number | undefined;
    frameId?: number;
    event?: string;
    bytes?: number;
    mediaType?: string | null;
  },
): string {
  const where =
    detail.frameId === undefined
      ? "a frame"
      : `frame id ${String(detail.frameId)}`;
  const after =
    detail.lastSeq === undefined
      ? "before any event was delivered"
      : `after seq ${String(detail.lastSeq)}`;
  switch (reason) {
    case "unexpected_media_type":
      return `0xinsider stream answered ${detail.mediaType ? `Content-Type ${detail.mediaType}` : "with no Content-Type"} instead of text/event-stream; not an SSE stream`;
    case "invalid_json":
      return `0xinsider stream sent ${where} whose data is not JSON (${String(detail.bytes ?? 0)} bytes) ${after}`;
    case "invalid_envelope":
      return `0xinsider stream sent ${where} whose data is not an envelope object ${after}`;
    case "unusable_sequence":
      return `0xinsider stream sent ${where} with no finite seq and no finite id ${after}`;
    case "invalid_resync":
      return `0xinsider stream sent a resync marker (${where}) whose data is not a resync object ${after}`;
    case "frame_too_large":
      return `0xinsider stream sent a frame past ${String(detail.bytes ?? 0)} bytes with no delimiter ${after}; the connection was closed`;
    default:
      return `0xinsider stream protocol error ${after}`;
  }
}

function assertMaxFrameBytes(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `maxFrameBytes must be a positive integer, got ${String(value)}`,
    );
  }
  return value;
}

/** `Content-Type` names an event stream: `text/event-stream`, with or without parameters. */
export function isEventStreamMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const essence = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return essence === "text/event-stream";
}

/** One yielded item from the stream iterator. */
export type StreamEvent =
  | { kind: "event"; seq: number; envelope: FeedEnvelope }
  | { kind: "resync"; seq: number | null; marker: ResyncMarker };

/**
 * Open the stream and async-iterate its frames. Yields a discriminated
 * `StreamEvent`: `kind: "event"` carries the `FeedEnvelope`, `kind: "resync"`
 * carries the `ResyncMarker`.
 *
 * Pass `options.cursor` (a `{ seq?: number }` object) to have the last
 * delivered `seq` written back as frames arrive; reconnect with
 * `lastEventId: cursor.seq` to resume after a transport drop.
 *
 * @example
 * for await (const frame of streamFeed(client, { event: ["WhaleTradesInserted"], min_grade: "S" })) {
 *   if (frame.kind === "event") console.log(frame.envelope.type, frame.seq);
 * }
 */
export async function* streamFeed(
  client: OxinsiderApiClient,
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent, void, undefined> {
  const maxFrameBytes = assertMaxFrameBytes(
    options.maxFrameBytes ?? DEFAULT_MAX_STREAM_FRAME_BYTES,
  );
  const apiKey = client.getApiKey();
  // The sandbox takes no credential; it answers the stream route with a 400
  // saying streams are not simulated, and that answer is the server's to
  // give (#16138). Production refuses a keyless stream, so say so locally.
  if (!apiKey && !client.isSandbox()) {
    throw new Error("getStream requires an API key (oxi_sk_*)");
  }

  const url = buildStreamUrl(client, options);
  const headers = new Headers({ accept: "text/event-stream" });
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  if (options.lastEventId !== undefined) {
    headers.set("last-event-id", String(options.lastEventId));
  }

  const fetchImpl = client.getFetch();
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await safeText(response);
    throw errorFromResponse(
      response.status,
      tryParse(body),
      retryAfterSeconds(response),
      { requestId: response.headers.get("x-request-id") },
    );
  }
  // A 2xx that is not an event stream (an HTML page from a proxy, a JSON body
  // from a route that moved) used to read as an empty stream that closed
  // cleanly, which the reconnect loop then retried as an outage (#16248).
  const mediaType = response.headers.get("content-type");
  if (!isEventStreamMediaType(mediaType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new StreamProtocolError("unexpected_media_type", {
      lastSeq: undefined,
      mediaType,
    });
  }
  if (!response.body) {
    throw new Error("Stream response has no readable body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  // Bytes of `buffer`: exact, since every chunk adds its own byte length and
  // a cut re-measures the remainder. Bounded by `maxFrameBytes`.
  let bufferedBytes = 0;
  let lastSeq: number | undefined;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      bufferedBytes += value.byteLength;

      // SSE frames are separated by a blank line. Handle CRLF and LF.
      let sepIndex = nextFrameBoundary(buffer);
      if (sepIndex.index === -1 && bufferedBytes > maxFrameBytes) {
        throw new StreamProtocolError("frame_too_large", {
          lastSeq,
          bytes: bufferedBytes,
        });
      }
      while (sepIndex.index !== -1) {
        const rawFrame = buffer.slice(0, sepIndex.index);
        // A complete frame is held to the same ceiling as an incomplete one,
        // before it is parsed, advances the cursor, or is yielded: a chunk
        // carrying an oversized frame and its delimiter together never reaches
        // the no-delimiter check above (#16644). `lastSeq` stays the last
        // delivered event.
        const frameBytes = encoder.encode(rawFrame).byteLength;
        if (frameBytes > maxFrameBytes) {
          throw new StreamProtocolError("frame_too_large", {
            lastSeq,
            bytes: frameBytes,
          });
        }
        buffer = buffer.slice(sepIndex.index + sepIndex.length);

        const parsed = parseSseFrame(rawFrame);
        if (parsed) {
          const frame = decodeStreamFrame(parsed, lastSeq);
          if (frame.kind === "resync") {
            options.onResync?.(frame.marker);
          } else {
            lastSeq = frame.seq;
            if (options.cursor) options.cursor.seq = frame.seq;
          }
          yield frame;
        }

        sepIndex = nextFrameBoundary(buffer);
      }
      bufferedBytes = buffer === "" ? 0 : encoder.encode(buffer).byteLength;
      if (bufferedBytes > maxFrameBytes) {
        throw new StreamProtocolError("frame_too_large", {
          lastSeq,
          bytes: bufferedBytes,
        });
      }
    }
  } finally {
    // `releaseLock()` detaches the reader but leaves the body -- and the
    // underlying HTTP connection -- open. Any early exit from the consumer
    // loop (`break`, `return`, or a throw from a handler) runs this block via
    // the generator's `return()`, so without `cancel()` every early exit leaks
    // one open connection to the SSE endpoint. The documented reconnect loop
    // makes that one leak per reconnect, until the process runs out of sockets
    // or the server's per-user SSE lease cap rejects the user's own
    // reconnects. `cancel()` releases the lock as part of cancelling, and can
    // reject on an already-errored stream, so the rejection is swallowed to
    // keep the `finally` non-throwing (#9682).
    await reader.cancel().catch(() => undefined);
  }
}

export interface ResilientStreamOptions extends StreamOptions {
  /**
   * Consecutive failed connections tolerated before giving up with
   * `StreamReconnectsExhaustedError`. A connection that delivers any frame
   * resets the count. Default `DEFAULT_MAX_STREAM_RECONNECTS` (10).
   */
  maxReconnects?: number;
  /**
   * Called before each reconnect's backoff: the 1-based consecutive attempt,
   * the seq the reconnect resumes after (`undefined` attaches live), and why
   * the previous connection ended (`undefined` for a clean server close).
   */
  onReconnect?: (
    attempt: number,
    lastSeq: number | undefined,
    cause: unknown,
  ) => void;
  /**
   * The longest server-requested wait (`Retry-After`) the loop holds
   * in-process, in ms. Default `DEFAULT_MAX_STREAM_RETRY_AFTER_MS` (60 000,
   * the REST client's ceiling). A refusal asking for longer ends the loop
   * with `StreamRetryDeferredError`, which carries the not-before instant
   * (`retryAt`) and the seq to resume after (`lastSeq`), so the wait is
   * yours to schedule and no reconnect is spent on it. `Infinity` opts into
   * waiting however long the server says, in timer-sized chunks; it can hold
   * the process for days on a `monthly_quota_exceeded` refusal, which is why
   * it is not the default (#16249).
   */
  maxRetryAfterMs?: number;
}

/** Default for `ResilientStreamOptions.maxReconnects`. */
export const DEFAULT_MAX_STREAM_RECONNECTS = 10;

/** Default for `ResilientStreamOptions.maxRetryAfterMs`. */
export const DEFAULT_MAX_STREAM_RETRY_AFTER_MS = RETRY_AFTER_CEILING_MS;

const STREAM_RECONNECT_BASE_MS = 1_000;
const STREAM_RECONNECT_MAX_MS = 30_000;
const STREAM_RECONNECT_JITTER_MS = 250;

/**
 * `streamFeedResilient` gave up after `maxReconnects` consecutive failed
 * connections. `lastSeq` is the seq to resume after (pass it as `lastEventId`
 * later); `cause` is the last connection's failure.
 */
export class StreamReconnectsExhaustedError extends Error {
  readonly lastSeq: number | undefined;
  readonly attempts: number;

  constructor(attempts: number, lastSeq: number | undefined, cause: unknown) {
    super(
      `0xinsider stream gave up after ${String(attempts)} consecutive reconnect attempts`,
      { cause },
    );
    this.name = "StreamReconnectsExhaustedError";
    this.attempts = attempts;
    this.lastSeq = lastSeq;
  }
}

/**
 * `streamFeedResilient` was refused with a `Retry-After` longer than
 * `maxRetryAfterMs`, so the wait is yours to schedule (#16249). `retryAt` is
 * the server's not-before instant as this client read it (the header's
 * seconds added to the local clock, or the header's HTTP-date); `cause` is
 * the refusal, whose `retryAt` (from the body's `retry_at`) is the server's
 * own clock reading of the same instant. `lastSeq` is the seq to resume after:
 * pass it as `lastEventId` when you reconnect at `retryAt`. `attempts` is how
 * many consecutive failed connections preceded this one; the refusal itself
 * spent none of `maxReconnects`.
 *
 * Nothing here was clamped: a wait the timer cannot hold is never shortened
 * into an earlier reconnect.
 */
export class StreamRetryDeferredError extends Error {
  readonly retryAt: Date;
  readonly retryAfterMs: number;
  readonly lastSeq: number | undefined;
  readonly attempts: number;

  constructor(
    retryAfterMs: number,
    lastSeq: number | undefined,
    attempts: number,
    cause: unknown,
  ) {
    const retryAt = new Date(Date.now() + retryAfterMs);
    super(
      `0xinsider stream refused with Retry-After ${String(Math.round(retryAfterMs / 1000))} s, past the in-process ceiling; reconnect after ${retryAt.toISOString()}${lastSeq === undefined ? "" : ` with lastEventId ${String(lastSeq)}`}`,
      { cause },
    );
    this.name = "StreamRetryDeferredError";
    this.retryAt = retryAt;
    this.retryAfterMs = retryAfterMs;
    this.lastSeq = lastSeq;
    this.attempts = attempts;
  }
}

/**
 * A 4xx other than 429 will fail the same way on every reconnect: a bad filter
 * (400), a key that is invalid (401), lapsed (402), refused (403), or locked
 * (423). Reconnecting would only hammer the API with a credential a person
 * has to fix.
 */
function isPermanentStreamError(error: unknown): boolean {
  // A protocol error is permanent too (#16248): reconnecting from `lastSeq`
  // replays the same frame while the server retains it, and a wrong media
  // type is the same answer on every connection.
  if (error instanceof StreamProtocolError) return true;
  // A terminal frame that said `retry: false` (#16546).
  if (error instanceof OxinsiderApiError && permanentTerminalErrors.has(error)) {
    return true;
  }
  return (
    error instanceof OxinsiderApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}

/**
 * The wait the server asked for, in ms, or `null` when the refusal carried
 * no usable `Retry-After` (a network error, a clean close, a 5xx without the
 * header). The header is parsed once, by `retry.ts`, when the error is built.
 */
function serverRequestedWaitMs(cause: unknown): number | null {
  return cause instanceof OxinsiderApiError &&
    "retryAfterSeconds" in cause &&
    typeof cause.retryAfterSeconds === "number" &&
    Number.isFinite(cause.retryAfterSeconds) &&
    cause.retryAfterSeconds >= 0
    ? cause.retryAfterSeconds * 1000
    : null;
}

/**
 * Milliseconds before reconnect `attempt` (1-based) when the server did not
 * say: a jittered exponential backoff from 1 s capped at 30 s. A server-
 * requested wait is handled by the loop, which checks it against
 * `maxRetryAfterMs` before adding jitter.
 */
function streamBackoffMs(attempt: number): number {
  const ceiling = Math.min(
    STREAM_RECONNECT_MAX_MS,
    STREAM_RECONNECT_BASE_MS * 2 ** (attempt - 1),
  );
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

function assertMaxRetryAfterMs(value: number): number {
  if (Number.isNaN(value) || value < 0) {
    throw new Error(
      `maxRetryAfterMs must be a non-negative number of milliseconds or Infinity, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * `streamFeed` with the reconnect-and-resume loop built in (#14286).
 *
 * - A clean server close, a network error, a 429 or a 5xx reconnects,
 *   resuming after the last delivered seq (`Last-Event-ID`). Before any frame
 *   arrives it resumes from `lastEventId`, or attaches live when that is unset.
 * - The wait is `Retry-After` (delta-seconds or an HTTP-date) plus jitter when
 *   the refusal carries one, otherwise a jittered backoff from 1 s capped at
 *   30 s. A `Retry-After` past `maxRetryAfterMs` (60 s by default) is not
 *   waited out: the loop throws `StreamRetryDeferredError` with `retryAt` and
 *   `lastSeq`, spending no reconnect, and never clamps the wait to an earlier
 *   one (#16249).
 * - Any other 4xx (400, 401, 402, 403, 423) is thrown at once: it cannot heal
 *   on its own. So is `StreamProtocolError` (#16248): a resume from
 *   `lastSeq` would replay the malformed frame, so the decision is yours.
 * - After `maxReconnects` consecutive connections that delivered nothing, it
 *   throws `StreamReconnectsExhaustedError` carrying `lastSeq`.
 * - `resync` markers are yielded unchanged, and `onResync` still fires. The
 *   marker's `id` becomes the resume cursor, as the server intends, so a
 *   reconnect after one does not request the aged window again.
 * - Aborting `signal` ends the iterator without throwing, during a connection
 *   or a backoff. Each connection's body reader is cancelled when it ends, so
 *   reconnects do not accumulate sockets.
 * - No request deadline applies, as with `streamFeed`.
 *
 * `options.cursor`, when passed, tracks the last delivered seq across every
 * connection -- delivered, not processed (#16247). This loop resumes from it,
 * so a consumer whose handler can fail should drive the stream with
 * `consumeStreamCheckpointed` instead, which resumes from an acknowledged
 * checkpoint and replays the event it failed on.
 *
 * @example
 * const controller = new AbortController();
 * for await (const frame of streamFeedResilient(client, {
 *   event: ["WhaleTradesInserted"],
 *   signal: controller.signal,
 *   onReconnect: (attempt, lastSeq, cause) => console.warn("reconnecting", attempt, lastSeq, cause),
 * })) {
 *   if (frame.kind === "resync") await refetchState();
 *   else handle(frame.envelope);
 * }
 */
export async function* streamFeedResilient(
  client: OxinsiderApiClient,
  options: ResilientStreamOptions = {},
): AsyncGenerator<StreamEvent, void, undefined> {
  const {
    maxReconnects = DEFAULT_MAX_STREAM_RECONNECTS,
    maxRetryAfterMs = DEFAULT_MAX_STREAM_RETRY_AFTER_MS,
    onReconnect,
    ...streamOptions
  } = options;
  if (!Number.isInteger(maxReconnects) || maxReconnects < 0) {
    throw new Error(
      `maxReconnects must be a non-negative integer, got ${String(maxReconnects)}`,
    );
  }
  const retryAfterCeilingMs = assertMaxRetryAfterMs(maxRetryAfterMs);
  // The one configuration error `streamFeed` throws before any request; it
  // would otherwise count as a transport failure and burn every reconnect.
  if (!client.getApiKey() && !client.isSandbox()) {
    throw new Error("streamFeedResilient requires an API key (oxi_sk_*)");
  }
  const signal = streamOptions.signal;
  const cursor: { seq?: number } = streamOptions.cursor ?? {};
  const initialLastEventId = streamOptions.lastEventId;
  let attempt = 0;

  for (;;) {
    if (signal?.aborted) return;
    let cause: unknown;
    try {
      for await (const frame of streamFeed(client, {
        ...streamOptions,
        cursor,
        lastEventId: cursor.seq ?? initialLastEventId,
      })) {
        attempt = 0;
        if (frame.kind === "resync" && frame.seq !== null) {
          cursor.seq = frame.seq;
        }
        yield frame;
      }
    } catch (error: unknown) {
      if (signal?.aborted) return;
      if (isPermanentStreamError(error)) throw error;
      cause = error;
    }
    if (signal?.aborted) return;

    const lastSeq = cursor.seq ?? toSeq(initialLastEventId);
    // A server-requested wait past the ceiling is deferred to the caller
    // BEFORE it counts as a reconnect: the server said when, and burning the
    // short reconnect budget on a wait we will not hold would be spending it
    // on nothing.
    const requestedMs = serverRequestedWaitMs(cause);
    if (requestedMs !== null && requestedMs > retryAfterCeilingMs) {
      throw new StreamRetryDeferredError(requestedMs, lastSeq, attempt, cause);
    }
    attempt += 1;
    if (attempt > maxReconnects) {
      throw new StreamReconnectsExhaustedError(attempt - 1, lastSeq, cause);
    }
    onReconnect?.(attempt, lastSeq, cause);
    const delayMs =
      requestedMs === null
        ? streamBackoffMs(attempt)
        : requestedMs + Math.random() * STREAM_RECONNECT_JITTER_MS;
    if (!(await waitUnlessAborted(delayMs, signal))) {
      return;
    }
  }
}

function toSeq(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seq = Number(value);
  return Number.isFinite(seq) ? seq : undefined;
}

/**
 * Callback-style stream consumer for environments where an async iterator is
 * awkward. Returns a promise that resolves when the stream ends (or rejects on
 * error / abort). Pass a `signal` to stop it.
 *
 * Delivery, not processing (#16247): `options.cursor` is written by
 * `streamFeed` BEFORE the frame is yielded, so it has already moved past an
 * event whose `onEvent` then throws. Reconnecting from it skips that event.
 * For a consumer that must not lose work, use `consumeStreamCheckpointed`,
 * which advances an acknowledged checkpoint only after the handler and your
 * own durable write have both resolved.
 */
export async function consumeStream(
  client: OxinsiderApiClient,
  handlers: {
    onEvent?: (envelope: FeedEnvelope, seq: number) => void | Promise<void>;
    onResync?: (marker: ResyncMarker, seq: number | null) => void | Promise<void>;
  },
  options: StreamOptions = {},
): Promise<void> {
  for await (const frame of streamFeed(client, options)) {
    if (frame.kind === "event") {
      await handlers.onEvent?.(frame.envelope, frame.seq);
    } else {
      await handlers.onResync?.(frame.marker, frame.seq);
    }
  }
}

/**
 * An acknowledged processing checkpoint (#16247): the last `seq` whose
 * handling COMPLETED, which is not the same thing as the last `seq` that
 * arrived. `StreamOptions.cursor` is the received cursor -- transport
 * progress, written before the frame is handed to you. This is the processed
 * one, written after your handler and your own durable write have resolved.
 *
 * Own the object if you persist the checkpoint yourself: pass it in, read
 * `seq` after the consumer returns or throws, and pass the stored value back
 * as `lastEventId` when you resume in a later process.
 */
export interface StreamCheckpoint {
  /** The last acknowledged sequence, or `undefined` until one is acknowledged. */
  seq?: number;
}

/** What the checkpoint advanced past: a feed envelope, or a resync refresh. */
export type StreamCheckpointReason = "event" | "resync";

/**
 * Which awaited step rejected: your event handler, your resync refresh, or
 * your `onCheckpoint` durable write.
 */
export type StreamHandlerStage = "event" | "resync" | "checkpoint";

/** The recovery state around one handler failure, as it is decided. */
export interface StreamHandlerFailure {
  /**
   * The sequence whose processing failed; `undefined` only for a resync
   * marker that carried no SSE id.
   */
  seq: number | undefined;
  /** Which awaited step rejected. */
  stage: StreamHandlerStage;
  /** 1-based consecutive failures at this sequence. Resets on any success. */
  attempt: number;
  /** Whether the consumer will reconnect and replay, or throw next. */
  willRetry: boolean;
  /**
   * The sequence the replay resumes AFTER, so the failed frame is delivered
   * again while the server retains it. `undefined` means the replay attaches
   * live and the failed frame is gone: that happens only when nothing has
   * been acknowledged, no `lastEventId` was given, and the failing sequence
   * is not a positive integer to step back from.
   */
  replayFrom: number | undefined;
  /** The acknowledged checkpoint, which this failure did NOT advance. */
  checkpoint: number | undefined;
}

/**
 * `consumeStreamCheckpointed` gave up after `maxHandlerRetries` consecutive
 * failures at the same sequence (#16247). `checkpoint` is the acknowledged
 * sequence, still behind the failing one, and `replayFrom` is the point a
 * later resume should pass as `lastEventId` to deliver the failed frame
 * again while the server retains it. `cause` is the last rejection your
 * handler produced.
 */
export class StreamHandlerFailedError extends Error {
  readonly seq: number | undefined;
  readonly stage: StreamHandlerStage;
  readonly attempts: number;
  readonly checkpoint: number | undefined;
  readonly replayFrom: number | undefined;

  constructor(
    detail: {
      seq: number | undefined;
      stage: StreamHandlerStage;
      attempts: number;
      checkpoint: number | undefined;
      replayFrom: number | undefined;
    },
    cause: unknown,
  ) {
    super(
      `0xinsider stream handler failed ${String(detail.attempts)} time(s) at ${
        detail.seq === undefined ? "a resync marker" : `seq ${String(detail.seq)}`
      } (${detail.stage}); the acknowledged checkpoint is ${
        detail.checkpoint === undefined ? "unset" : String(detail.checkpoint)
      }`,
      { cause },
    );
    this.name = "StreamHandlerFailedError";
    this.seq = detail.seq;
    this.stage = detail.stage;
    this.attempts = detail.attempts;
    this.checkpoint = detail.checkpoint;
    this.replayFrom = detail.replayFrom;
  }
}

/** Default for `CheckpointedStreamOptions.maxHandlerRetries`. */
export const DEFAULT_MAX_HANDLER_RETRIES = 3;

export interface CheckpointedStreamOptions extends ResilientStreamOptions {
  /**
   * Where the acknowledged checkpoint is written. Pass your own object to
   * read it after the consumer returns; omit it and the consumer keeps one
   * internally, which `onCheckpoint` still reports.
   */
  checkpoint?: StreamCheckpoint;
  /**
   * Consecutive failures at the SAME sequence tolerated before the consumer
   * throws `StreamHandlerFailedError`. Each retry closes the connection and
   * replays from the checkpoint after a jittered backoff (1 s to 30 s). `0`
   * gives up on the first failure. Default `DEFAULT_MAX_HANDLER_RETRIES` (3).
   */
  maxHandlerRetries?: number;
  /**
   * Called on every handler failure with the recovery state, before the
   * backoff and before any throw. It is the visible signal that work is being
   * replayed rather than lost; it is not awaited and must not throw.
   */
  onHandlerError?: (error: unknown, failure: StreamHandlerFailure) => void;
}

export interface CheckpointedStreamHandlers {
  /**
   * Apply one feed envelope. Awaited: the connection is not read again until
   * it settles. Reject to leave the checkpoint before this event.
   */
  onEvent: (envelope: FeedEnvelope, seq: number) => void | Promise<void>;
  /**
   * Refresh state after a resync marker. Awaited, so it is a real barrier:
   * the checkpoint moves to the marker only once this resolves. Reject and
   * the refresh is retried under the same bounded policy as an event.
   */
  onResync?: (marker: ResyncMarker, seq: number | null) => void | Promise<void>;
  /**
   * Persist the checkpoint. Awaited BEFORE the in-memory checkpoint advances,
   * so a failed write leaves the checkpoint where it was and the event is
   * replayed rather than lost.
   */
  onCheckpoint?: (
    seq: number,
    reason: StreamCheckpointReason,
  ) => void | Promise<void>;
}

/**
 * The resume point that replays `seq` itself when nothing has been
 * acknowledged yet.
 *
 * `Last-Event-ID` is an EXCLUSIVE lower bound on the server: the replay
 * window is `latest - requested` entries taken from the tail of the retained
 * history, so a resume at `S - 1` delivers `S` onward and nothing older
 * (`shared_feed_history_since`, `backend/crates/app-core/src/feed_publisher.rs`;
 * `backend/src/api_v1/handlers/stream.rs` builds the plan from it, read
 * 2026-09-22). Sequences are a cluster-wide integer counter, so nothing sits
 * between `S - 1` and `S`. A non-integer or non-positive sequence gets no
 * step-back: there is no id we can name that is certainly below it.
 */
function replayPointBefore(seq: number | undefined): number | undefined {
  return seq !== undefined && Number.isInteger(seq) && seq >= 1
    ? seq - 1
    : undefined;
}

/**
 * The stream consumer for work that must not be silently dropped (#16247):
 * it separates the received cursor from an acknowledged processing
 * checkpoint, and only the checkpoint decides where a reconnect resumes.
 *
 * Ordering, per frame, for `kind: "event"`:
 *   1. `onEvent` is awaited. Nothing is read from the connection while it
 *      runs, so a slow handler is backpressure on the socket, never a queue:
 *      at most one frame is ever in flight and nothing is buffered on your
 *      behalf.
 *   2. `onCheckpoint(seq, "event")` is awaited -- your durable write.
 *   3. Only then does `checkpoint.seq` become `seq`, and only then does the
 *      next reconnect resume after it.
 * A rejection at step 1 or 2 leaves the checkpoint BEFORE the event: the
 * connection is closed, a jittered backoff runs, and the consumer reconnects
 * from the checkpoint, which replays the unacknowledged event while the
 * server retains it. `onHandlerError` reports each failure with its attempt
 * number, the replay point and whether another attempt follows. After
 * `maxHandlerRetries` consecutive failures at the same sequence it throws
 * `StreamHandlerFailedError`, carrying the unadvanced checkpoint.
 *
 * A `resync` marker is the same barrier: `onResync` is awaited, then
 * `onCheckpoint(seq, "resync")`, and an interrupted refresh commits nothing,
 * so the recovery is retried instead of being recorded as done. (The
 * fire-and-forget `StreamOptions.onResync` notification is not awaited and is
 * not a barrier -- do not use it as one.)
 *
 * Delivery is AT-LEAST-ONCE. A replay re-delivers every unacknowledged frame,
 * and a handler that succeeded but whose `onCheckpoint` write failed sees its
 * event again. Deduplicate on `seq` (it is monotonic per cluster) or make the
 * side effect idempotent; nothing here can promise exactly-once side effects.
 *
 * `options.cursor` is untouched in meaning: it still tracks the last
 * DELIVERED seq, including frames whose handler later failed, and it rewinds
 * when a replay re-delivers them. Read it for transport progress; never as
 * proof that the work was done.
 *
 * Transport recovery, `Retry-After` handling, permanent 4xx and
 * `StreamProtocolError` behave exactly as in `streamFeedResilient`, which
 * this drives. `StreamReconnectsExhaustedError` and
 * `StreamRetryDeferredError` surface unchanged; their `lastSeq` is the
 * acknowledged checkpoint, because a reconnect can only happen between
 * handlers. Aborting `signal` ends the consumer without throwing: a handler
 * already running is awaited (it is not cancelled for you -- pass the same
 * signal into your own work if you want that), and if it succeeds its
 * checkpoint is committed before the consumer returns.
 *
 * @example
 * const checkpoint = { seq: await loadCheckpoint() };
 * await consumeStreamCheckpointed(client, {
 *   onEvent: async (envelope, seq) => { await applyOnce(seq, envelope); },
 *   onResync: async () => { await refetchCurrentState(); },
 *   onCheckpoint: async (seq) => { await saveCheckpoint(seq); },
 * }, {
 *   event: ["WhaleTradesInserted"],
 *   lastEventId: checkpoint.seq,
 *   checkpoint,
 *   signal: controller.signal,
 *   onHandlerError: (error, failure) =>
 *     console.warn("replaying", failure.seq, failure.attempt, failure.willRetry, error),
 * });
 */
export async function consumeStreamCheckpointed(
  client: OxinsiderApiClient,
  handlers: CheckpointedStreamHandlers,
  options: CheckpointedStreamOptions = {},
): Promise<void> {
  const {
    checkpoint = {},
    maxHandlerRetries = DEFAULT_MAX_HANDLER_RETRIES,
    onHandlerError,
    ...streamOptions
  } = options;
  if (!Number.isInteger(maxHandlerRetries) || maxHandlerRetries < 0) {
    throw new Error(
      `maxHandlerRetries must be a non-negative integer, got ${String(maxHandlerRetries)}`,
    );
  }
  const signal = streamOptions.signal;
  // The caller's received cursor, if they passed one. It keeps its delivery
  // meaning: this consumer mirrors every frame into it and never reads it
  // back as a resume point.
  const received = streamOptions.cursor;
  const initialLastEventId = toSeq(streamOptions.lastEventId);
  // Where the next connection resumes. It starts at the acknowledged
  // checkpoint (or the caller's `lastEventId`) and only ever moves to a
  // sequence whose processing completed.
  let resumeAfter = checkpoint.seq ?? initialLastEventId;
  let failingSeq: number | undefined;
  let failures = 0;

  for (;;) {
    if (signal?.aborted) return;
    let pending:
      | { error: unknown; stage: StreamHandlerStage; seq: number | undefined }
      | undefined;
    // A cursor private to this connection: `streamFeedResilient` reads it
    // back as its own resume point across transport reconnects, so the
    // caller's received cursor must never be handed to it -- that cursor has
    // already moved past an unacknowledged event, and lending it would make
    // the replay resume after the frame it exists to redeliver.
    const delivered: { seq?: number } = { seq: resumeAfter };

    for await (const frame of streamFeedResilient(client, {
      ...streamOptions,
      cursor: delivered,
      lastEventId: resumeAfter,
    })) {
      if (received && delivered.seq !== undefined) received.seq = delivered.seq;

      if (frame.kind === "event") {
        try {
          await handlers.onEvent(frame.envelope, frame.seq);
        } catch (error: unknown) {
          pending = { error, stage: "event", seq: frame.seq };
          break;
        }
        try {
          await handlers.onCheckpoint?.(frame.seq, "event");
        } catch (error: unknown) {
          pending = { error, stage: "checkpoint", seq: frame.seq };
          break;
        }
        checkpoint.seq = frame.seq;
        resumeAfter = frame.seq;
      } else {
        try {
          await handlers.onResync?.(frame.marker, frame.seq);
        } catch (error: unknown) {
          pending = { error, stage: "resync", seq: frame.seq ?? undefined };
          break;
        }
        if (frame.seq !== null) {
          try {
            await handlers.onCheckpoint?.(frame.seq, "resync");
          } catch (error: unknown) {
            pending = { error, stage: "checkpoint", seq: frame.seq };
            break;
          }
          checkpoint.seq = frame.seq;
          resumeAfter = frame.seq;
        }
      }
      failures = 0;
      failingSeq = undefined;
      if (signal?.aborted) return;
    }

    // `streamFeedResilient` only ends without throwing when the signal was
    // aborted, so a loop that ends with nothing pending is a clean stop.
    if (!pending) return;

    const failedSeq = pending.seq;
    if (failures > 0 && failedSeq === failingSeq) {
      failures += 1;
    } else {
      failingSeq = failedSeq;
      failures = 1;
    }
    resumeAfter =
      checkpoint.seq ?? initialLastEventId ?? replayPointBefore(failedSeq);
    const willRetry = failures <= maxHandlerRetries;
    onHandlerError?.(pending.error, {
      seq: failedSeq,
      stage: pending.stage,
      attempt: failures,
      willRetry,
      replayFrom: resumeAfter,
      checkpoint: checkpoint.seq,
    });
    if (!willRetry) {
      throw new StreamHandlerFailedError(
        {
          seq: failedSeq,
          stage: pending.stage,
          attempts: failures,
          checkpoint: checkpoint.seq,
          replayFrom: resumeAfter,
        },
        pending.error,
      );
    }
    if (!(await waitUnlessAborted(streamBackoffMs(failures), signal))) {
      return;
    }
  }
}

function buildStreamUrl(
  client: OxinsiderApiClient,
  options: StreamFilters,
): string {
  // Through the same resolver as `buildUrl`, so a path-bearing base such as
  // the sandbox's `/sandbox` lands in the same place for REST and SSE.
  const url = resolveApiUrl(client.getBaseUrl(), "/api/v1/stream");
  if (options.event && options.event.length > 0) {
    url.searchParams.set("event", options.event.join(","));
  }
  if (options.condition_id) {
    url.searchParams.set("condition_id", options.condition_id);
  }
  if (options.min_grade) {
    url.searchParams.set("min_grade", options.min_grade);
  }
  return url.toString();
}

export interface ParsedSseFrame {
  event?: string;
  id?: number;
  data: string;
}

/** Parse one SSE frame (without the trailing blank line). */
export function parseSseFrame(raw: string): ParsedSseFrame | null {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  let id: number | undefined;
  const dataParts: string[] = [];
  let sawField = false;

  for (const line of lines) {
    if (line === "" || line.startsWith(":")) {
      // Blank or comment line (e.g. ": keep-alive"): ignore.
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        event = value;
        sawField = true;
        break;
      case "id": {
        const n = Number(value);
        if (Number.isFinite(n)) id = n;
        sawField = true;
        break;
      }
      case "data":
        dataParts.push(value);
        sawField = true;
        break;
      default:
        // Unknown SSE field; ignore per the spec.
        break;
    }
  }

  if (!sawField && dataParts.length === 0) {
    return null;
  }
  return { event, id, data: dataParts.join("\n") };
}

/** Find the next SSE frame boundary (blank line); handles `\n\n` and `\r\n\r\n`. */
function nextFrameBoundary(buffer: string): { index: number; length: number } {
  // Three terminator shapes, not two (#9682). A producer that ends FIELD lines
  // with CRLF but the blank separator line with a bare LF yields "\r\n\n",
  // which the old two-way scan cut at the "\n\n" -- one byte late, leaving a
  // trailing "\r" on the last field. `parseSseFrame` splits on /\r?\n/ and so
  // cannot strip a "\r" from a line with no newline after it, which turned
  // `event: resync` into `event: "resync\r"` and made the exact `=== "resync"`
  // routing check fail: the resume marker the cursor protocol depends on was
  // silently delivered as a malformed envelope. The current Axum backend emits
  // LF only, so this hardens a latent path rather than fixing a live break.
  const candidates: { index: number; length: number }[] = [
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\r\n\n"), length: 3 },
    { index: buffer.indexOf("\n\n"), length: 2 },
  ].filter((candidate) => candidate.index !== -1);
  if (candidates.length === 0) return { index: -1, length: 0 };
  // Earliest boundary wins; on a tie the LONGEST terminator wins, because
  // "\r\n\r\n" and "\r\n\n" both also match "\n\n" at a later index and a
  // short match would leave terminator bytes in the next frame.
  return candidates.reduce((best, candidate) =>
    candidate.index < best.index ||
    (candidate.index === best.index && candidate.length > best.length)
      ? candidate
      : best,
  );
}

/**
 * Turn one parsed SSE frame into a `StreamEvent`, or throw
 * `StreamProtocolError` (#16248). `lastSeq` is only carried onto the error.
 */
export function decodeStreamFrame(
  parsed: ParsedSseFrame,
  lastSeq: number | undefined,
): StreamEvent {
  const detail = {
    lastSeq,
    frameId: parsed.id,
    event: parsed.event,
    bytes: new TextEncoder().encode(parsed.data).byteLength,
  };
  let payload: unknown;
  try {
    payload = parsed.data === "" ? undefined : JSON.parse(parsed.data);
  } catch {
    throw new StreamProtocolError("invalid_json", detail);
  }
  if (parsed.event === "error") {
    throw terminalStreamError(payload, detail);
  }
  if (parsed.event === "resync") {
    if (!isPlainObject(payload)) {
      throw new StreamProtocolError("invalid_resync", detail);
    }
    if ("type" in payload && payload.type !== "resync") {
      throw new StreamProtocolError("invalid_resync", detail);
    }
    return {
      kind: "resync",
      seq: parsed.id ?? null,
      marker: payload as ResyncMarker,
    };
  }
  if (payload === undefined) {
    throw new StreamProtocolError("invalid_json", detail);
  }
  if (!isPlainObject(payload)) {
    throw new StreamProtocolError("invalid_envelope", detail);
  }
  const seq =
    typeof payload.seq === "number" && Number.isFinite(payload.seq)
      ? payload.seq
      : parsed.id;
  if (seq === undefined || !Number.isFinite(seq)) {
    throw new StreamProtocolError("unusable_sequence", detail);
  }
  return { kind: "event", seq, envelope: payload as FeedEnvelope };
}

/**
 * The HTTP status the reconnect is answered with, for each code a terminal
 * `event: error` frame carries (#16546). The frame has no status of its own;
 * this mirrors `ApiError::status_code` in `backend/crates/api-core`, so the
 * error thrown mid-stream is the one the next request would get.
 */
const STREAM_ERROR_CODE_STATUS: Readonly<Record<string, number>> = {
  bad_request: 400,
  invalid_api_key: 401,
  subscription_required: 402,
  forbidden: 403,
  insufficient_scope: 403,
  not_found: 404,
  request_timeout: 408,
  account_locked: 423,
  rate_limited: 429,
  internal_error: 500,
  rate_limit_unavailable: 503,
};
const STREAM_ERROR_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "database_unavailable",
  "read_model_warming",
  "request_accounting_unavailable",
]);

/**
 * Errors built from a terminal frame that said `retry: false`: permanent
 * whatever their status, so no consumer reconnects on them (#16546).
 */
const permanentTerminalErrors = new WeakSet<OxinsiderApiError>();

/**
 * The typed error a terminal `event: error` frame stands for (#16546).
 *
 * The backend ends `/api/v1/stream` with `{ "type": "error", "error": {...},
 * "retry": <bool> }` when the key is revoked, the account lapses, or the
 * credential store cannot confirm the key. The frame is never a feed event:
 * it is thrown, so it reaches no handler and moves no cursor or checkpoint.
 * `retry: false` is permanent; `retry: true` goes through the resilient
 * consumer's reconnect path like any 5xx.
 */
function terminalStreamError(
  payload: unknown,
  detail: ConstructorParameters<typeof StreamProtocolError>[1],
): Error {
  if (!isPlainObject(payload) || !isPlainObject(payload.error)) {
    return new StreamProtocolError("invalid_envelope", detail);
  }
  const body = payload.error;
  const retry = payload.retry === true;
  const code = typeof body.code === "string" ? body.code : undefined;
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const status =
    reason !== undefined && STREAM_ERROR_UNAVAILABLE_REASONS.has(reason)
      ? 503
      : ((code !== undefined ? STREAM_ERROR_CODE_STATUS[code] : undefined) ??
        (retry ? 503 : 400));
  const error = errorFromResponse(status, { object: "error", error: body });
  if (!retry) permanentTerminalErrors.add(error);
  return error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParse(text: string | null): unknown {
  if (text === null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
