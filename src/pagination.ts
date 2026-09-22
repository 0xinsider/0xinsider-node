/**
 * Cursor pagination over the Stripe-style V1 list envelope.
 *
 * Every list endpoint returns `{ object: "list", data, has_more, next_cursor }`
 * (`backend/src/api_v1/types.rs` `ApiList`: `has_more` is always a boolean,
 * `next_cursor` is a string or omitted). `paginate()` yields each `data[]`
 * item across pages, following `next_cursor` while `has_more` is true.
 * `paginatePages()` yields whole pages when you need the envelope (e.g. to
 * read `meta.cost` or `total`).
 *
 * The walker is a progress-checked consumer of that protocol (#16246):
 *
 * - A page is validated BEFORE it is yielded. `has_more: true` with no usable
 *   `next_cursor` is a `PaginationError` (`missing_cursor`); the backend's own
 *   cursor builders refuse to produce that page ("has_more is true for an
 *   empty page", `insider_radar.rs`), so a client seeing it is looking at a
 *   malformed response, not the end of the collection. Before #16246 the
 *   walk returned as if the collection were exhausted.
 * - A `next_cursor` that repeats a cursor this walk already requested is a
 *   `PaginationError` (`repeated_cursor`), thrown before the duplicate
 *   request. The last `CURSOR_HISTORY_LIMIT` cursors are remembered; a cycle
 *   longer than that is not detected, which bounds memory on a long walk.
 * - `maxPages` is validated before any request: a positive integer or
 *   `Infinity`; `0`, a negative, fractional or `NaN` value throws `RangeError`.
 * - `has_more: false` ends the walk normally, whatever `next_cursor` says.
 * - A `PaginationError` carries the offending `page`, so its data is not lost,
 *   and registers a resume point like any other failure.
 *
 * `options.progress`, when passed, is updated as the walk goes: how many
 * pages were fetched, the last cursor requested, the `next_cursor` of the
 * last page, and why the walk stopped, so a caller that stops at `maxPages`
 * can tell "the collection has more" from "the collection is exhausted" and
 * keep the continuation.
 */

import type {
  ApiListEnvelope,
  ApiOperationId,
  ApiRequestOptions,
  ListOperationId,
  ListParams,
  OperationEnvelope,
  OperationItem,
  OxinsiderApiClient,
} from "./client.js";
import type { OperationPath, OperationQuery } from "./schema.js";

/**
 * How many requested cursors a walk remembers for the repeat check. A cycle
 * longer than this is not detected; the bound keeps a long walk's memory
 * flat instead of growing with every page.
 */
export const CURSOR_HISTORY_LIMIT = 1_024;

/** Why a walk ended; see `PaginationProgress.stoppedBy`. */
export type PaginationStop =
  /** The server said `has_more: false`: the collection is exhausted. */
  | "exhausted"
  /** The caller's `maxPages` was reached; `nextCursor` continues the walk. */
  | "max_pages";

/**
 * Live progress of a walk (#16246). Pass an object as `options.progress`
 * and read it after the loop; it is updated before each page is yielded and
 * when the walk ends. On a throw it holds the state at the failed page, the
 * same information `paginationResumePoint(error)` returns.
 */
export interface PaginationProgress {
  /** Pages fetched and yielded so far. */
  pagesFetched?: number;
  /** The cursor the most recent page was requested with; `undefined` for the first page. */
  cursor?: string;
  /**
   * The most recent page's `next_cursor`. After `stoppedBy: "max_pages"`
   * this is the continuation: pass it as `query.cursor` to carry on.
   * `null` or `undefined` once the collection is exhausted.
   */
  nextCursor?: string | null;
  /** Set when the walk ends without throwing. */
  stoppedBy?: PaginationStop;
}

export interface PaginateOptions {
  /** Path parameters for templated list paths (e.g. `{ id }` for deliveries). */
  path?: ApiRequestOptions["path"];
  /** Initial query params (filters, `limit`, an initial `cursor`, ...). */
  query?: ListParams;
  /** Reject query names the operation does not publish before the first request. */
  strictQuery?: ApiRequestOptions["strictQuery"];
  /** Forwarded to each request for cooperative cancellation. */
  signal?: AbortSignal;
  /** Per-request deadline, forwarded to each page; see `ApiRequestOptions.timeoutMs`. */
  timeoutMs?: number | null;
  /** Retries per page, forwarded to each request; see `ApiRequestOptions.maxRetries`. */
  maxRetries?: number;
  /** Extra headers on every page, such as a conditional read's `If-None-Match`. */
  headers?: Record<string, string>;
  /**
   * Hard cap on pages fetched. A positive integer, or `Infinity` / omitted
   * for no cap. Anything else (`0`, negative, fractional, `NaN`) throws a
   * `RangeError` before any request. Reaching it is a caller choice, not
   * exhaustion: `progress.stoppedBy` reads `"max_pages"` and
   * `progress.nextCursor` holds the continuation.
   */
  maxPages?: number;
  /** Updated as the walk goes; see `PaginationProgress`. */
  progress?: PaginationProgress;
}

/**
 * `PaginateOptions` bound to one list operation (#16136): `path` required
 * exactly when the route has path parameters, `query` the documented query.
 */
export type OperationPaginateOptions<K extends ListOperationId> = Omit<
  PaginateOptions,
  "path" | "query"
> &
  (OperationPath[K] extends Record<string, never>
    ? { path?: OperationPath[K] }
    : { path: OperationPath[K] }) & { query?: OperationQuery[K] };

/** Where an interrupted walk can pick up again; see `paginationResumePoint`. */
export interface PaginationResumePoint {
  /**
   * The cursor of the page that failed. Pass it back as `query.cursor` to
   * refetch that page and continue. `undefined` means the first page failed,
   * so start the walk again without a cursor.
   */
  cursor: string | undefined;
  /** Pages already yielded before the failure. */
  pagesFetched: number;
}

/** What a page did that the list protocol does not allow. */
export type PaginationErrorReason =
  /** `has_more: true` with no usable `next_cursor` (missing, `null` or empty). */
  | "missing_cursor"
  /** `next_cursor` repeats a cursor this walk already requested: a cycle. */
  | "repeated_cursor";

/**
 * The server's list response broke the pagination protocol (#16246). The
 * walk stops before yielding the page and before any further request.
 *
 * `page` is the response as received, so its `data` is still available to
 * you; `cursor` is what that page was requested with (`undefined` for the
 * first page) and `nextCursor` is what it offered next. `pagesFetched`
 * counts the pages already yielded. `paginationResumePoint(error)` returns
 * `{ cursor, pagesFetched }` for this error too. Retrying the same page later
 * is reasonable for a transient server fault; a repeat on the same cursor
 * means the route's cursor is broken and is worth reporting with
 * `page.meta.request_id`.
 */
export class PaginationError<T = unknown> extends Error {
  readonly reason: PaginationErrorReason;
  readonly operationId: ApiOperationId;
  readonly cursor: string | undefined;
  readonly nextCursor: string | null | undefined;
  readonly pagesFetched: number;
  readonly page: ApiListEnvelope<T>;

  constructor(
    reason: PaginationErrorReason,
    operationId: ApiOperationId,
    page: ApiListEnvelope<T>,
    cursor: string | undefined,
    pagesFetched: number,
  ) {
    const requestId = page.meta?.request_id;
    super(
      reason === "missing_cursor"
        ? `0xinsider API ${operationId} page ${String(pagesFetched + 1)} says has_more but carries no next_cursor${requestId ? ` (request ${requestId})` : ""}; the walk cannot continue safely`
        : `0xinsider API ${operationId} page ${String(pagesFetched + 1)} offers next_cursor ${JSON.stringify(page.next_cursor)}, which this walk already requested${requestId ? ` (request ${requestId})` : ""}; stopping before the duplicate request`,
    );
    this.name = "PaginationError";
    this.reason = reason;
    this.operationId = operationId;
    this.cursor = cursor;
    this.nextCursor = page.next_cursor;
    this.pagesFetched = pagesFetched;
    this.page = page;
  }
}

const resumePoints = new WeakMap<object, PaginationResumePoint>();

/**
 * The resume point of an error thrown out of `paginatePages`, `paginate` or
 * `collect`, or `undefined` for any other error (#14281).
 *
 * Each page request already retries a 429 or 5xx (`maxRetries`). When those
 * retries are exhausted the ORIGINAL error is rethrown unchanged, so an
 * `instanceof RateLimitedError` check keeps working, and this function recovers
 * the cursor that the throw would otherwise have destroyed with the generator.
 * A `PaginationError` (#16246) is registered the same way.
 *
 * @example
 * try {
 *   for await (const trade of paginate(client, "listWhaleTrades", { query })) handle(trade);
 * } catch (err) {
 *   const resume = paginationResumePoint(err);
 *   if (resume) later(() => paginate(client, "listWhaleTrades", { query: { ...query, cursor: resume.cursor } }));
 * }
 */
export function paginationResumePoint(
  error: unknown,
): PaginationResumePoint | undefined {
  return typeof error === "object" && error !== null
    ? resumePoints.get(error)
    : undefined;
}

function assertMaxPages(value: number | undefined): number {
  if (value === undefined || value === Infinity) return Infinity;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `maxPages must be a positive integer or Infinity, got ${String(value)}`,
    );
  }
  return value;
}

/** A `next_cursor` the walk can request: a non-empty string. */
function usableCursor(value: string | null | undefined): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Async-iterate whole list pages, following `next_cursor` until exhausted.
 * Yields the full envelope so callers can read `meta`/`total`/`has_more`.
 * A failed page throws its original error; `paginationResumePoint(error)`
 * returns the cursor to continue from. A page that breaks the protocol
 * throws `PaginationError` before it is yielded (#16246).
 */
export function paginatePages<K extends ListOperationId>(
  client: OxinsiderApiClient,
  operationId: K,
  options?: OperationPaginateOptions<K>,
): AsyncGenerator<OperationEnvelope<K>, void, undefined>;
/** The untyped form: a runtime-chosen operation, or a caller-asserted `T`. */
export function paginatePages<T = unknown>(
  client: OxinsiderApiClient,
  operationId: ApiOperationId,
  options?: PaginateOptions,
): AsyncGenerator<ApiListEnvelope<T>, void, undefined>;
export async function* paginatePages(
  client: OxinsiderApiClient,
  operationId: ApiOperationId,
  options: PaginateOptions = {},
): AsyncGenerator<unknown, void, undefined> {
  const { path, query, strictQuery, signal, progress, timeoutMs, maxRetries, headers } = options;
  const maxPages = assertMaxPages(options.maxPages);
  let cursor: string | undefined = query?.cursor;
  let pages = 0;
  // Every cursor requested so far, newest last, capped at CURSOR_HISTORY_LIMIT.
  const requested = new Set<string>();
  const requestedOrder: string[] = [];
  const remember = (value: string) => {
    if (requested.has(value)) return;
    requested.add(value);
    requestedOrder.push(value);
    if (requestedOrder.length > CURSOR_HISTORY_LIMIT) {
      const oldest = requestedOrder.shift();
      if (oldest !== undefined) requested.delete(oldest);
    }
  };
  const record = (
    fields: Pick<PaginationProgress, "pagesFetched" | "cursor" | "nextCursor"> &
      Partial<Pick<PaginationProgress, "stoppedBy">>,
  ) => {
    if (progress) Object.assign(progress, fields);
  };
  const fail = (error: object) => {
    if (!resumePoints.has(error)) {
      resumePoints.set(error, { cursor, pagesFetched: pages });
    }
    return error;
  };

  for (;;) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The pagination was aborted", "AbortError");
    }
    if (cursor !== undefined) remember(cursor);

    let page: ApiListEnvelope<unknown>;
    try {
      page = await client.list<unknown>(operationId, {
        path,
        query: { ...query, ...(cursor === undefined ? {} : { cursor }) },
        strictQuery,
        signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(maxRetries === undefined ? {} : { maxRetries }),
        ...(headers === undefined ? {} : { headers }),
      });
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null) fail(error);
      throw error;
    }

    record({ pagesFetched: pages, cursor, nextCursor: page.next_cursor });
    const next = page.next_cursor;
    if (page.has_more) {
      if (!usableCursor(next)) {
        throw fail(new PaginationError("missing_cursor", operationId, page, cursor, pages));
      }
      if (requested.has(next)) {
        throw fail(new PaginationError("repeated_cursor", operationId, page, cursor, pages));
      }
    }

    yield page;
    pages += 1;
    record({ pagesFetched: pages, cursor, nextCursor: next });

    if (!page.has_more) {
      record({ pagesFetched: pages, cursor, nextCursor: next, stoppedBy: "exhausted" });
      return;
    }
    if (pages >= maxPages) {
      record({ pagesFetched: pages, cursor, nextCursor: next, stoppedBy: "max_pages" });
      return;
    }
    // `has_more` was true and `next` passed both checks above.
    cursor = next as string;
  }
}

/**
 * Async-iterate individual `data[]` items across all pages.
 *
 * @example
 * for await (const trade of paginate(client, "listWhaleTrades", {
 *   query: { min_grade: "S", limit: 100 },
 * })) {
 *   handle(trade); // typed as the route's whale trade (#16136)
 * }
 */
export function paginate<K extends ListOperationId>(
  client: OxinsiderApiClient,
  operationId: K,
  options?: OperationPaginateOptions<K>,
): AsyncGenerator<OperationItem<K>, void, undefined>;
/** The untyped form: a runtime-chosen operation, or a caller-asserted `T`. */
export function paginate<T = unknown>(
  client: OxinsiderApiClient,
  operationId: ApiOperationId,
  options?: PaginateOptions,
): AsyncGenerator<T, void, undefined>;
export async function* paginate(
  client: OxinsiderApiClient,
  operationId: ApiOperationId,
  options: PaginateOptions = {},
): AsyncGenerator<unknown, void, undefined> {
  for await (const page of paginatePages<unknown>(client, operationId, options)) {
    for (const item of page.data) {
      yield item;
    }
  }
}

/**
 * Collect every item across all pages into one array. Convenience over
 * `paginate()` for small result sets; prefer the iterator for large ones.
 */
export function collect<K extends ListOperationId>(
  client: OxinsiderApiClient,
  operationId: K,
  options?: OperationPaginateOptions<K>,
): Promise<OperationItem<K>[]>;
/** The untyped form: a runtime-chosen operation, or a caller-asserted `T`. */
export function collect<T = unknown>(
  client: OxinsiderApiClient,
  operationId: ApiOperationId,
  options?: PaginateOptions,
): Promise<T[]>;
export async function collect(
  client: OxinsiderApiClient,
  operationId: ApiOperationId,
  options: PaginateOptions = {},
): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of paginate<unknown>(client, operationId, options)) {
    items.push(item);
  }
  return items;
}
