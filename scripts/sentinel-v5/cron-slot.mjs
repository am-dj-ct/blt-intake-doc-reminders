// Cron-schedule slot resolution — ported from blt-hub master's
// src/sentinel-v5/{cron.ts,engine.ts} (spec v5.9 §3.2), mirroring
// caller-track's own scripts/sentinel-v5/cron-slot.mjs port byte-for-byte.
//
// `at` and `slot` MUST be captured TOGETHER at job invocation start, never
// recomputed at completion — a completion-time `at` on a long job can map to
// a later slot than the one legitimately claimed, and blt-hub's real
// consumer (engine.ts's validateSlotClaim) rejects the mismatch as
// red(slot_mismatch).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

export class SentinelV5CronError extends Error {}

const FIELD_BOUNDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 },  // day of week (0 and 7 are Sunday)
];

export function parseCron(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new SentinelV5CronError(`cron must have 5 fields: ${expression}`);
  }
  const sets = fields.map((field, index) => parseField(field, FIELD_BOUNDS[index].min, FIELD_BOUNDS[index].max));
  const dow = sets[4];
  if (dow.has(7)) dow.add(0);
  return {
    minutes: sets[0],
    hours: sets[1],
    dom: sets[2],
    months: sets[3],
    dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(",")) {
    const stepMatch = /^(.+?)\/(\d+)$/.exec(part);
    const base = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new SentinelV5CronError(`bad step in: ${field}`);
    let lo, hi;
    if (base === "*") {
      lo = min;
      hi = max;
    } else {
      const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(base);
      if (!rangeMatch) throw new SentinelV5CronError(`bad field: ${field}`);
      lo = Number(rangeMatch[1]);
      hi = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new SentinelV5CronError(`out of range: ${field}`);
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  if (values.size === 0) throw new SentinelV5CronError(`empty field: ${field}`);
  return values;
}

function cronDayMatches(spec, year, month, day) {
  if (!spec.months.has(month)) return false;
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domMatch = spec.dom.has(day);
  const dowMatch = spec.dow.has(dow);
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch;
  if (spec.domRestricted) return domMatch;
  if (spec.dowRestricted) return dowMatch;
  return true;
}

const formatterCache = new Map();

function zoneFormatter(tz) {
  let formatter = formatterCache.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatterCache.set(tz, formatter);
  }
  return formatter;
}

export function zonedParts(utcMs, tz) {
  const parts = zoneFormatter(tz).formatToParts(new Date(utcMs));
  const get = (type) => {
    const part = parts.find((entry) => entry.type === type);
    if (!part) throw new SentinelV5CronError(`missing ${type} from Intl parts`);
    return Number(part.value);
  };
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

export function localToUtc(tz, parts) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let guess = desired;
  for (let round = 0; round < 3; round += 1) {
    const seen = zonedParts(guess, tz);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    const diff = desired - seenAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  const roundTrip = zonedParts(guess, tz);
  if (roundTrip.year !== parts.year || roundTrip.month !== parts.month || roundTrip.day !== parts.day
    || roundTrip.hour !== parts.hour || roundTrip.minute !== parts.minute) {
    return undefined;
  }
  for (const deltaMs of [7_200_000, 3_600_000, 1_800_000]) {
    const earlier = guess - deltaMs;
    const earlierParts = zonedParts(earlier, tz);
    if (earlierParts.year === parts.year && earlierParts.month === parts.month && earlierParts.day === parts.day
      && earlierParts.hour === parts.hour && earlierParts.minute === parts.minute) {
      return earlier;
    }
  }
  return guess;
}

export function isScheduleSlot(schedule, utcMs) {
  if (utcMs % 60_000 !== 0) return false;
  const spec = parseCron(schedule.cron);
  const parts = zonedParts(utcMs, schedule.tz);
  return cronDayMatches(spec, parts.year, parts.month, parts.day)
    && spec.hours.has(parts.hour)
    && spec.minutes.has(parts.minute)
    && localToUtc(schedule.tz, parts) === utcMs;
}

export function slotsBetween(schedule, fromMsExclusive, toMsInclusive) {
  if (toMsInclusive <= fromMsExclusive) return [];
  const spec = parseCron(schedule.cron);
  const slots = [];
  const startParts = zonedParts(fromMsExclusive, schedule.tz);
  const endParts = zonedParts(toMsInclusive, schedule.tz);
  let cursor = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
  const endDate = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
  const hours = [...spec.hours].sort((a, b) => a - b);
  const minutes = [...spec.minutes].sort((a, b) => a - b);
  while (cursor <= endDate) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (cronDayMatches(spec, year, month, day)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const utc = localToUtc(schedule.tz, { year, month, day, hour, minute });
          if (utc === undefined) continue;
          if (utc > fromMsExclusive && utc <= toMsInclusive) slots.push(utc);
        }
      }
    }
    cursor += 86_400_000;
  }
  slots.sort((a, b) => a - b);
  return slots;
}

const ARMING_HORIZONS_MS = [32 * 86_400_000, 400 * 86_400_000, 8 * 366 * 86_400_000];

function normalizeSlotIso(slotIso) {
  const ms = Date.parse(slotIso);
  if (!Number.isFinite(ms)) return slotIso;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The latest slot at or before `now`, matching blt-hub's captureInvocationSlot. */
export function captureInvocationSlot(schedule, now = new Date()) {
  const nowMs = now.getTime();
  for (const horizon of ARMING_HORIZONS_MS) {
    const slots = slotsBetween(schedule, nowMs - horizon, nowMs);
    const last = slots[slots.length - 1];
    if (last !== undefined) return normalizeSlotIso(new Date(last).toISOString());
  }
  return undefined;
}

// ---- blt-intake-doc-reminders registry fragment lookup (this repo's own schedule) ----

export const SENTINEL_V5_FRAGMENT_PATH_ENV = "SENTINEL_V5_FRAGMENT_PATH";

let cachedFragment;
let cachedFragmentItems;

/** Test/drill override — mirrors blt-hub's own SENTINEL_V5_REGISTRY_PATH
 * override pattern (paths.ts). Production reads the real, committed
 * fragment; tests point this at a fixture with enabled:true so the
 * disabled-item gate (which the real fragment intentionally carries,
 * pre-activation) doesn't have to be worked around in every test. */
function loadFragmentRaw() {
  if (cachedFragmentItems) return cachedFragmentItems;
  const override = process.env[SENTINEL_V5_FRAGMENT_PATH_ENV]?.trim();
  const fragmentPath =
    override ||
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "sentinel-v5-registry-fragment.blt-intake-doc-reminders.json");
  const fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
  cachedFragmentItems = new Map(fragment.items.map((item) => [item.id, item]));
  return cachedFragmentItems;
}

export function loadFragmentSchedules() {
  if (cachedFragment) return cachedFragment;
  cachedFragment = new Map([...loadFragmentRaw()].map(([id, item]) => [id, item.schedule]));
  return cachedFragment;
}

/**
 * Acceptance window in ms for a registered item — grace_minutes + skew_minutes,
 * matching the tolerance blt-hub's own consumer applies (a check-in claiming a
 * slot older than this from `now` reads as a genuinely late/manual run, not a
 * legitimate scheduled invocation). Review finding (r1 desktop-janitor #2,
 * false-page): a manual run hours after the real scheduled slot must NOT
 * silently claim that old slot and emit — see captureInvocationWithin below.
 */
export function acceptanceWindowMs(item, fallbackMinutes = 60) {
  const raw = loadFragmentRaw().get(item);
  const graceMinutes = raw?.grace_minutes ?? fallbackMinutes;
  const skewMinutes = raw?.skew_minutes ?? 0;
  return (graceMinutes + skewMinutes) * 60_000;
}

/**
 * Resolve the invocation-start slot for a registered item, using THIS repo's
 * own registry fragment as the schedule source.
 *
 * Round-5 fix (activation-blocker): acceptanceWindowMs() above was defined
 * but never actually applied here. captureInvocationSlot searches up to a
 * 32/400/~2900-day horizon (ARMING_HORIZONS_MS) for the LATEST matching
 * slot — that horizon exists to find a slot at all across arming gaps, not
 * to bound how stale a claimed slot may be. Without this check, a manual
 * or late invocation run hours (or days) after the real scheduled slot
 * would still resolve to that old slot and emit a check-in claiming it —
 * confirmed live: a reviewer's manual run 780 minutes after the real slot
 * was silently accepted. A slot older than grace_minutes + skew_minutes
 * from `now` is a late/manual invocation, not a legitimate scheduled run,
 * and must resolve to "no slot" (emit nothing) — same contract callers
 * already expect (checkin-helper.mjs's `if (!invocation.slot) return;`).
 */
export function slotForItem(item, now = new Date()) {
  const schedules = loadFragmentSchedules();
  const schedule = schedules.get(item);
  if (!schedule) {
    throw new SentinelV5CronError(`no schedule for item: ${item}`);
  }
  const slot = captureInvocationSlot(schedule, now);
  if (slot === undefined) {
    throw new SentinelV5CronError(`no slot found for item ${item} within the search horizon`);
  }
  const slotMs = Date.parse(slot);
  const staleMs = now.getTime() - slotMs;
  const windowMs = acceptanceWindowMs(item);
  if (staleMs > windowMs) {
    throw new SentinelV5CronError(
      `slot ${slot} is ${Math.round(staleMs / 60_000)}m stale for ${item} (outside the ${Math.round(windowMs / 60_000)}m acceptance window) — manual/late invocation`,
    );
  }
  return slot;
}

/**
 * Contract-parity fix (round-2 residual): a registered item's own fragment
 * row can be `enabled: false` (every wave-1 row ships that way — the
 * coordinator's registry PR flips it after import). The producer must
 * treat that the same way blt-hub's own consumer does: fully inert, not
 * merely skipped downstream. Returns true if the item is unknown to this
 * fragment too (fail toward emitting is wrong; but that case is already
 * caught earlier by slotForItem's own "no schedule for item" throw, so in
 * practice this only ever answers for a real, present row).
 */
export function isItemEnabled(item) {
  const raw = loadFragmentRaw().get(item);
  return raw?.enabled !== false;
}
