#!/usr/bin/env node
// Sentinel-v5 check-in emitter for blt-intake-doc-reminders — the one call the
// job's wrapper (run.sh, via checkin-lib.sh) makes. Builds a schema-v2 payload
// (spec v5.9 §3.2) and admits it to the shared local spool via
// spool-producer.mjs. Ported from desktop-janitor's scripts/sentinel-v5/
// checkin.mjs, which mirrors caller-track's.
//
// Importable API: emitCheckin({ item, status, reasonCode, at, slot, runSuffix }).
// CLI:
//   node scripts/sentinel-v5/checkin.mjs --capture-invocation --item idr-hourly-reminders
//     -> {"at":"...","slot":"..."} on stdout (exit 1 + stderr if no slot resolves)
//   node scripts/sentinel-v5/checkin.mjs --item idr-hourly-reminders \
//        --status green --reason-code ok --at <iso> --slot <iso>
//
// `at` and `slot` are captured TOGETHER at invocation start (see cron-slot.mjs)
// — never recomputed at job completion. run.sh captures them once before the
// job body and passes the same pair to the completion check-in.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeRunId, evidenceRefFor, SENTINEL_V5_REASON_CODES, SENTINEL_V5_STATUSES } from "./checkin-schema.mjs";
import { resolveSpoolRoot, spoolProduceCheckin } from "./spool-producer.mjs";
import { slotForItem } from "./cron-slot.mjs";

export const INTAKE_DOC_REMINDERS_REPO = "blt-intake-doc-reminders";

export const SENTINEL_V5_B1_DARK_MARKER_ENV = "SENTINEL_V5_B1_DARK_MARKER";

// Same shared dark-marker gate every repo in the fleet checks before writing
// to the spool (blt-hub's src/sentinel-v5/spool.ts isB1Dark) — an unactivated
// fleet must never receive a real spool entry a not-yet-live consumer would
// never process.
export function resolveDarkMarkerPath(env = process.env) {
  return env[SENTINEL_V5_B1_DARK_MARKER_ENV]?.trim() || join(homedir(), ".blt-sentinel", "b1-dark");
}

export function isB1Dark(env = process.env) {
  const path = resolveDarkMarkerPath(env);
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

// Test seam for the wrapper smoke test: a fixed "now" for slot capture, so a
// test can land inside the 35-minute acceptance window at any wall-clock
// time. Honored ONLY when the spool root is also overridden — a faked
// invocation time can never reach the real ~/.blt-sentinel/spool.
export const SENTINEL_V5_TEST_NOW_ENV = "SENTINEL_V5_TEST_NOW";
export function invocationNow(env = process.env) {
  const raw = env[SENTINEL_V5_TEST_NOW_ENV]?.trim();
  if (!raw) return new Date();
  if (!env.SENTINEL_V5_SPOOL_ROOT?.trim()) {
    process.stderr.write(`sentinel: ${SENTINEL_V5_TEST_NOW_ENV} ignored (real spool root in use)\n`);
    return new Date();
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`invalid ${SENTINEL_V5_TEST_NOW_ENV}: ${raw}`);
  return new Date(ms);
}

/** Resolve {at, slot} for an item at invocation start. Throws when no slot
 * within the acceptance window resolves (manual/late run) — callers emit
 * nothing in that case. */
export function captureInvocation(item, now = new Date()) {
  const at = now.toISOString();
  const slot = slotForItem(item, now);
  return { at, slot };
}

/**
 * @param {object} args
 * @param {string} args.item - registry item id (e.g. "idr-hourly-reminders")
 * @param {"green"|"yellow"|"red"} args.status
 * @param {string} args.reasonCode - closed vocab, see checkin-schema.mjs
 * @param {string} args.slot - ISO UTC slot, captured at invocation start
 * @param {string} [args.at] - ISO UTC invocation instant, captured with slot
 * @param {string} [args.repo] - defaults to "blt-intake-doc-reminders"
 * @param {string} [args.runSuffix] - overrides the run_id's "<epoch>-<pid>" tail
 * @param {string} [args.spoolRoot] - override for tests
 * @param {Date} [args.now] - override for both "at" and the run_id timestamp
 * @param {NodeJS.ProcessEnv} [args.env] - override for the B1 dark-marker lookup
 */
export function emitCheckin({ item, status, reasonCode, slot, at: atArg, repo = INTAKE_DOC_REMINDERS_REPO, runSuffix, spoolRoot, now, env = process.env }) {
  if (!SENTINEL_V5_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  if (!SENTINEL_V5_REASON_CODES.includes(reasonCode)) {
    throw new Error(`invalid reason_code: ${reasonCode}`);
  }
  if (isB1Dark(env)) {
    return { filename: null, admitted: false, reason: "sentinel_v5_b1_dark" };
  }
  const at = atArg ?? (now ? now.toISOString() : nowIso());
  const runId = runSuffix ? `${item}-${runSuffix}` : makeRunId(item, now ?? new Date());
  const checkin = {
    schema: 2,
    item,
    repo,
    status,
    at,
    slot,
    run_id: runId,
    reason_code: reasonCode,
    overwrote_prior: false,
    evidence_ref: evidenceRefFor(item, runId),
  };
  const root = spoolRoot ?? resolveSpoolRoot(env);
  return spoolProduceCheckin(root, checkin);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key === "now" || key === "capture-invocation") {
      out[key] = true;
      continue;
    }
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

// CLI entry point — only runs when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.now) {
    process.stdout.write(`${nowIso()}\n`);
    process.exit(0);
  }
  if (args["capture-invocation"]) {
    try {
      const invocation = captureInvocation(args.item, invocationNow());
      process.stdout.write(`${JSON.stringify(invocation)}\n`);
      process.exit(0);
    } catch (err) {
      process.stderr.write(`sentinel slot capture failed: ${err?.message ?? err}\n`);
      process.exit(1);
    }
  }
  try {
    const result = emitCheckin({
      item: args.item,
      status: args.status,
      reasonCode: args["reason-code"],
      at: args.at,
      slot: args.slot,
      repo: args.repo,
    });
    process.stdout.write(`${result.filename ?? `(skipped: ${result.reason ?? "not admitted"})`}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`sentinel checkin failed: ${err?.message ?? err}\n`);
    // Producers never block the caller's real job — checkin-lib.sh swallows
    // this exit code and logs it to the fallback log.
    process.exit(1);
  }
}
