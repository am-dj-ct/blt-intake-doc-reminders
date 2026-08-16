// Sentinel-v5 check-in wire schema v2 — ported (via desktop-janitor) from blt-hub master's
// src/sentinel-v5/schema.ts (spec v5.9 §3.2), mirroring caller-track's own
// port at scripts/sentinel-v5/checkin-schema.mjs byte-for-byte (same
// closed-vocab field set, patterns, and validation), so a payload this repo
// admits to the shared spool is what blt-hub's consumer already accepts.
// This repo does NOT grow SENTINEL_V5_REASON_CODES independently.

export const SENTINEL_V5_SCHEMA_VERSION = 2;

export const SENTINEL_V5_STATUSES = ["green", "yellow", "red"];
export const SENTINEL_V5_CHILD_STATUSES = ["green", "red", "missing"];

export const SENTINEL_V5_REASON_CODES = [
  "ok",
  "job_failed",
  "degraded",
  "oversize",
  "producer_reject",
  "drill",
  // v5.11 green-failure classes 1-13 — kept in sync with blt-hub's real
  // schema.ts even though this repo's own producer never emits any of
  // these (round-4 residual: local schema ports only carried 6 of the
  // hub contract's 19 codes).
  "cost_runaway",
  "expiry_approaching",
  "over_execution",
  "writer_overlap",
  "order_violation",
  "backlog_growth",
  "capacity_low",
  "deadline_miss",
  "provenance_drift",
  "calendar_mismatch",
  "posture_violation",
  "restore_stale",
  "retention_violation",
];

export const SENTINEL_V5_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SENTINEL_V5_RUN_ID_SUFFIX_PATTERN = /^\d{10,14}-\d{1,7}$/;

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export class SentinelV5SchemaError extends Error {}

export function isIsoUtc(value) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  const canonical = new Date(ms).toISOString();
  return canonical.slice(0, 19) === value.slice(0, 19);
}

export function makeRunId(item, now = new Date(), pid = process.pid) {
  return `${item}-${now.getTime()}-${pid}`;
}

export function evidenceRefFor(item, runId) {
  return `${item}/${runId}`;
}

const CHECKIN_KEYS = new Set([
  "schema", "item", "repo", "status", "at", "slot", "run_id",
  "reason_code", "overwrote_prior", "children", "evidence_ref",
]);
const CHILD_KEYS = new Set(["child", "status", "observed_at", "run_ref"]);

export function validateCheckinShape(value, isGroup) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SentinelV5SchemaError("check-in must be an object");
  }
  const record = value;
  for (const key of Object.keys(record)) {
    if (!CHECKIN_KEYS.has(key)) throw new SentinelV5SchemaError(`unknown field: ${key}`);
  }
  if (record.schema !== SENTINEL_V5_SCHEMA_VERSION) {
    throw new SentinelV5SchemaError(`schema must be ${SENTINEL_V5_SCHEMA_VERSION}`);
  }
  const item = record.item;
  if (typeof item !== "string" || !SENTINEL_V5_ITEM_ID_PATTERN.test(item)) {
    throw new SentinelV5SchemaError("invalid item id");
  }
  if (typeof record.repo !== "string" || record.repo.length === 0 || record.repo.length > 200) {
    throw new SentinelV5SchemaError("invalid repo");
  }
  if (!SENTINEL_V5_STATUSES.includes(record.status)) {
    throw new SentinelV5SchemaError("invalid status");
  }
  if (!isIsoUtc(record.at)) throw new SentinelV5SchemaError("invalid at");
  if (!isIsoUtc(record.slot)) throw new SentinelV5SchemaError("invalid slot");
  const runId = record.run_id;
  if (
    typeof runId !== "string" ||
    !runId.startsWith(`${item}-`) ||
    !SENTINEL_V5_RUN_ID_SUFFIX_PATTERN.test(runId.slice(item.length + 1))
  ) {
    throw new SentinelV5SchemaError("invalid run_id");
  }
  if (!SENTINEL_V5_REASON_CODES.includes(record.reason_code)) {
    throw new SentinelV5SchemaError("invalid reason_code");
  }
  if (typeof record.overwrote_prior !== "boolean") {
    throw new SentinelV5SchemaError("invalid overwrote_prior");
  }
  if (record.evidence_ref !== evidenceRefFor(item, runId)) {
    throw new SentinelV5SchemaError("evidence_ref must be <item>/<run_id>");
  }
  if (isGroup) {
    if (!Array.isArray(record.children)) {
      throw new SentinelV5SchemaError("group item requires a children array");
    }
    if (record.children.length === 0 && record.reason_code !== "oversize") {
      throw new SentinelV5SchemaError("children may be empty only on oversize replacements");
    }
    for (const child of record.children) {
      validateChild(child);
    }
  } else if (record.children !== undefined) {
    throw new SentinelV5SchemaError("children present on non-group item");
  }
  return record;
}

function validateChild(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SentinelV5SchemaError("child must be an object");
  }
  const record = value;
  for (const key of Object.keys(record)) {
    if (!CHILD_KEYS.has(key)) throw new SentinelV5SchemaError(`unknown child field: ${key}`);
  }
  if (typeof record.child !== "string" || !SENTINEL_V5_ITEM_ID_PATTERN.test(record.child)) {
    throw new SentinelV5SchemaError("invalid child id");
  }
  if (!SENTINEL_V5_CHILD_STATUSES.includes(record.status)) {
    throw new SentinelV5SchemaError("invalid child status");
  }
  if (!isIsoUtc(record.observed_at)) throw new SentinelV5SchemaError("invalid child observed_at");
  if (typeof record.run_ref !== "string" || record.run_ref.length === 0 || record.run_ref.length > 200) {
    throw new SentinelV5SchemaError("invalid child run_ref");
  }
}
