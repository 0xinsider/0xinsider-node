/**
 * One default decision over a response's `data_quality` block (#16965).
 *
 * `data_quality` says how old each part of a body is; it does not say whether
 * that is old enough to act on, because the tolerance belongs to the caller.
 * This helper applies one: a pure function over the response, with no request
 * of its own. The Python SDK (`assess_data_quality`) and the Go SDK
 * (`AssessDataQuality`) carry the same rule under the same name.
 *
 * The rule:
 * - A group passes only when its `status` is `fresh`, it carries `as_of`, and
 *   that clock is within `maxAgeMs` of `now`. `fresh` alone means tracked and
 *   clocked, not current enough for you.
 * - `untracked` groups are left out of the verdict: 0xinsider does not track
 *   them for this subject by design, so there is no age to hold them to. They
 *   are listed in `untracked` so a caller that needs one can refuse the body.
 * - Every other status fails: `unknown` (served, but this read cannot date
 *   it; never treat missing as recent), `partial`, `unavailable`, and any
 *   status this SDK version does not recognize.
 */
import type { DataQuality, DataQualityGroup } from "./schema.js";

export interface AssessDataQualityOptions {
  /** The oldest clock you accept, in milliseconds. */
  maxAgeMs: number;
  /**
   * Only judge these groups. A named group the body does not carry fails with
   * reason `missing`, so a renamed or removed group cannot pass silently.
   * Omitted: judge every group the body carries.
   */
  groups?: readonly string[];
  /** The instant to measure against. Defaults to `Date.now()`. */
  now?: Date | number;
}

export interface DataQualityFailure {
  group: string;
  /** The group's status, or `missing` when a requested group is absent. */
  status: DataQualityGroup["status"] | "missing" | (string & {});
  as_of?: string | undefined;
  /** How far `as_of` sits before `now`, when the group carries a clock. */
  ageMs?: number | undefined;
  /** The server's reason when it gave one, otherwise why this helper failed it. */
  reason: string;
}

export interface DataQualityAssessment {
  /**
   * True when at least one group was judged and every judged group is fresh
   * and within `maxAgeMs`. A body with nothing to judge (every group
   * `untracked`) is not ok: nothing in it could be dated.
   */
  ok: boolean;
  /** The oldest `as_of` among the judged groups that carry one. */
  oldestAsOf?: string | undefined;
  /** Age of `oldestAsOf` at `now`. */
  oldestAgeMs?: number | undefined;
  /** Every judged group that did not pass, in response order. */
  failing: DataQualityFailure[];
  /** Groups left out of the verdict because they are `untracked`. */
  untracked: string[];
}

/**
 * Judge a `data_quality` block against your own tolerance.
 *
 * @example
 * const trader = await client.getTrader(address);
 * // Accepts the block itself or any object carrying it (a trader's data, a list page).
 * const verdict = assessDataQuality(trader.data, { maxAgeMs: 15 * 60_000 });
 * if (!verdict.ok) {
 *   // verdict.failing names each group, its status and its age.
 * }
 */
export function assessDataQuality(
  quality: DataQuality | { data_quality: DataQuality },
  options: AssessDataQualityOptions,
): DataQualityAssessment {
  const block = "data_quality" in quality ? quality.data_quality : quality;
  if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
    throw new RangeError("assessDataQuality: maxAgeMs must be a finite, non-negative number");
  }
  const nowMs =
    options.now === undefined
      ? Date.now()
      : typeof options.now === "number"
        ? options.now
        : options.now.getTime();

  const byName = new Map(block.field_groups.map((entry) => [entry.group, entry]));
  const judged: DataQualityGroup[] = [];
  const failing: DataQualityFailure[] = [];
  const untracked: string[] = [];

  const names = options.groups ?? block.field_groups.map((entry) => entry.group);
  for (const name of names) {
    const entry = byName.get(name);
    if (!entry) {
      failing.push({ group: name, status: "missing", reason: "the response carries no such group" });
      continue;
    }
    if (entry.status === "untracked") {
      untracked.push(name);
      continue;
    }
    judged.push(entry);
  }

  let oldestMs: number | undefined;
  let oldestAsOf: string | undefined;
  for (const entry of judged) {
    const clockMs = entry.as_of === undefined ? Number.NaN : Date.parse(entry.as_of);
    const hasClock = Number.isFinite(clockMs);
    const ageMs = hasClock ? nowMs - clockMs : undefined;
    if (hasClock && (oldestMs === undefined || clockMs < oldestMs)) {
      oldestMs = clockMs;
      oldestAsOf = entry.as_of;
    }
    const base = { group: entry.group, status: entry.status, as_of: entry.as_of, ageMs };
    if (entry.status !== "fresh") {
      failing.push({ ...base, reason: entry.reason ?? `status is ${entry.status}` });
    } else if (!hasClock) {
      failing.push({ ...base, reason: "fresh but carries no as_of, so no age can be measured" });
    } else if (ageMs !== undefined && ageMs > options.maxAgeMs) {
      failing.push({ ...base, reason: `older than maxAgeMs (${options.maxAgeMs})` });
    }
  }

  return {
    ok: failing.length === 0 && judged.length > 0,
    oldestAsOf,
    oldestAgeMs: oldestMs === undefined ? undefined : nowMs - oldestMs,
    failing,
    untracked,
  };
}
