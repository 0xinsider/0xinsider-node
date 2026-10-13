/**
 * `Retry-After` parsing and the waits it drives, shared by the REST retry
 * loop (`client.ts`) and the SSE reconnect loop (`stream.ts`) so the two
 * cannot read the same header differently (#16249).
 *
 * Two facts shape this module:
 *
 * 1. `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3,
 *    https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after). Both
 *    loops parsed only the number and treated a date as "no header".
 * 2. Node schedules a `setTimeout` delay above 2147483647 ms (about 24.8 days)
 *    as 1 ms, with a warning
 *    (https://nodejs.org/api/timers.html#settimeoutcallback-delay-args). The
 *    stream loop multiplied any `Retry-After` by 1000 and handed it straight
 *    to the timer, so a long server-requested wait -- `monthly_quota_exceeded`
 *    names the first of next month -- would have reconnected at once, the
 *    opposite of what the server asked.
 *
 * The policy is therefore: parse both forms into a non-negative number of
 * seconds; never wait in-process past a ceiling the caller can see (60 s by
 * default, the same for REST and SSE); when the server asks for longer, hand
 * the caller a typed error carrying the not-before instant and the resume
 * context, never a clamped earlier retry; and when a caller opts into waiting
 * longer, wait in timer-sized chunks so the timer range is never exceeded.
 */

/**
 * The largest delay one `setTimeout` can hold in Node (2^31 - 1 ms). A larger
 * value is scheduled as 1 ms, so every wait here is cut into chunks of at
 * most this size.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The longest server-requested wait either loop holds in-process by default.
 * A `Retry-After` beyond it is the caller's to schedule: the REST loop throws
 * the response's error (`retryAfterSeconds`, `retryAt`), the stream loop
 * throws `StreamRetryDeferredError`.
 */
export const RETRY_AFTER_CEILING_MS = 60_000;

/**
 * Parse a `Retry-After` header value into seconds to wait, or `null` when
 * there is no usable value.
 *
 * - Delta-seconds: a finite, non-negative number (`"60"`, `"1.5"`). A negative
 *   or non-finite number (`"-1"`, `"Infinity"`, `"NaN"`) is `null`: the
 *   grammar does not allow it, and guessing a wait from it would be inventing
 *   a server instruction.
 * - HTTP-date (`"Wed, 01 Oct 2026 00:00:00 GMT"`): the seconds from `nowMs`
 *   to that instant. A date already past is `0` (the server said "after an
 *   instant that has passed", which is "now"), never negative.
 * - Anything else (`""`, `"soon"`) is `null`.
 *
 * `null` means "as if the header were absent": the caller falls back to its
 * own backoff. It never means "retry at once".
 */
export function parseRetryAfter(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (header === null || header === undefined) return null;
  const text = header.trim();
  if (text === "") return null;
  // `Number("")` is 0 and `Number(" 5 ")` is 5, so the trim above and the
  // empty check keep a blank header from reading as "retry now".
  const delta = Number(text);
  if (!Number.isNaN(delta)) {
    return Number.isFinite(delta) && delta >= 0 ? delta : null;
  }
  const dateMs = Date.parse(text);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, (dateMs - nowMs) / 1000);
}

/** `parseRetryAfter` over a response's `Retry-After` header. */
export function retryAfterSeconds(response: Response): number | null {
  return parseRetryAfter(response.headers.get("retry-after"));
}

/**
 * Parse a `Retry-After` header value by the RFC 9110 grammar alone into whole
 * seconds, or `null` when it does not match.
 *
 * `parseRetryAfter` drives this module's own waits and keeps its documented
 * extensions (a fractional delay, any date `Date.parse` reads). This one is
 * for a caller that hands the seconds on as a validated fact rather than
 * waiting on them: the stdio MCP server's `retry_after_seconds` field and its
 * "Retry after Ns." text (#19729), which must agree and must never present a
 * malformed header as an instruction.
 *
 * - delay-seconds: digits only (`"60"`). A sign, fraction, exponent, trailing
 *   text, or a value past `Number.MAX_SAFE_INTEGER` is `null`.
 * - HTTP-date: IMF-fixdate, the obsolete RFC 850 form and asctime, with the
 *   calendar date and the weekday checked. The delay counts from `nowMs` and
 *   rounds up to a whole second; a date already past is `0`.
 * - Anything else, an empty value included, is `null`.
 */
export function parseRetryAfterStrict(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const dateMs = httpDateMs(value, nowMs);
  if (dateMs === null) return null;
  const seconds = Math.max(0, Math.ceil((dateMs - nowMs) / 1000));
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/** RFC 9110 section 5.6.7: all three HTTP-date forms, with UTC calendar validation. */
function httpDateMs(value: string, nowMs: number): number | null {
  const shortDay = "(Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
  const month = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const clock = "(\\d{2}):(\\d{2}):(\\d{2})";
  let match: string[] | null = new RegExp(
    `^${shortDay}, (\\d{2}) ${month} (\\d{4}) ${clock} GMT$`,
  ).exec(value);
  let obsoleteYear = false;
  if (!match) {
    match = new RegExp(
      `^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-${month}-(\\d{2}) ${clock} GMT$`,
    ).exec(value);
    obsoleteYear = match !== null;
  }
  let captures: readonly (string | undefined)[];
  if (!match) {
    const asctime = new RegExp(
      `^${shortDay} ${month} (\\d{2}| \\d) ${clock} (\\d{4})$`,
    ).exec(value);
    if (!asctime) return null;
    captures = [
      asctime[1],
      asctime[3],
      asctime[2],
      asctime[7],
      asctime[4],
      asctime[5],
      asctime[6],
    ];
  } else {
    captures = match.slice(1);
  }
  const [weekday, dayText, monthText, yearText, hourText, minuteText, secondText] =
    captures;
  if (
    weekday === undefined ||
    dayText === undefined ||
    monthText === undefined ||
    yearText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined
  )
    return null;
  const day = Number(dayText);
  const monthIndex = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(monthText);
  let year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 60) return null;

  const date = new Date(0);
  const future = new Date(nowMs);
  future.setUTCFullYear(future.getUTCFullYear() + 50);
  if (obsoleteYear) year += Math.floor(future.getUTCFullYear() / 100) * 100;
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (obsoleteYear && date.getTime() > future.getTime()) {
    year -= 100;
    date.setUTCFullYear(year, monthIndex, day);
  }
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day
  )
    return null;
  if (
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()] !==
    weekday.slice(0, 3)
  )
    return null;
  return date.getTime() + (second === 60 ? 1000 : 0);
}

/**
 * Resolve after `ms`, or reject with the signal's reason the moment it
 * aborts. A wait longer than `MAX_TIMER_DELAY_MS` runs as consecutive timers
 * of at most that size, so it is never handed to `setTimeout` as one value
 * that Node would schedule as 1 ms. `ms` must be a non-negative number;
 * `Infinity` is refused because it can never elapse.
 */
export async function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!(ms >= 0) || !Number.isFinite(ms)) {
    throw new RangeError(
      `sleepUnlessAborted needs a finite non-negative delay, got ${String(ms)}`,
    );
  }
  const notBefore = Date.now() + ms;
  let remaining = ms;
  for (;;) {
    await timerUnlessAborted(Math.min(remaining, MAX_TIMER_DELAY_MS), signal);
    remaining = notBefore - Date.now();
    if (remaining <= 0) return;
  }
}

/** Resolve `true` after `ms`, or `false` the moment `signal` aborts. */
export async function waitUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    await sleepUnlessAborted(ms, signal);
    return true;
  } catch (error: unknown) {
    if (signal?.aborted) return false;
    throw error;
  }
}

function timerUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      reject(reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      const reason: unknown = signal?.reason;
      reject(reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
