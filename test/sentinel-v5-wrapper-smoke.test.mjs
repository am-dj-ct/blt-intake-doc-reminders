// Smoke test: run the REAL run.sh wrapper end to end (dry-run, synthetic job
// body, temp spool root) and assert a sentinel check-in file lands with the
// right verdict for every failure mode the wrapper distinguishes:
//   green ok        — job exited 0
//   yellow degraded — job exited 0 but reported an untrusted scrape
//   red job_failed  — job exited non-zero (incl. the wrapper's own
//                     attestation refusal, exercised with NO override)
//   (nothing)       — manual run outside the slot acceptance window
// No TherapyNotes, no Doppler, no email: the override script replaces the
// job body, and the wrapper only honors it together with --dry-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const RUN_SH = join(REPO, "run.sh");
const NODE22 = "/opt/homebrew/opt/node@22/bin/node";
const ITEM = "idr-hourly-reminders";
// 14:36 PDT — one minute after the 14:35 slot, inside the acceptance window.
const IN_WINDOW = "2026-08-15T21:36:00Z";
const EXPECTED_SLOT = "2026-08-15T21:35:00Z";
// 15:20 PDT — 45 minutes past 14:35, outside grace 30 + skew 5.
const OUT_OF_WINDOW = "2026-08-15T22:20:00Z";

const haveNode22 = existsSync(NODE22);

function fakeJob(dir, { rc = 0, health = "" } = {}) {
  const script = join(dir, "fake-job.sh");
  writeFileSync(script, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'echo "fake job args: $*"',
    health ? `if [ -n "\${BLT_INTAKE_DOC_REMINDERS_HEALTH_FILE:-}" ]; then printf '%s\\n' ${JSON.stringify(health)} > "$BLT_INTAKE_DOC_REMINDERS_HEALTH_FILE"; fi` : "",
    `exit ${rc}`,
    "",
  ].join("\n"));
  chmodSync(script, 0o700);
  return script;
}

function runWrapper({ dir, args = ["--dry-run"], override, testNow = IN_WINDOW, env = {} }) {
  const spool = join(dir, "spool");
  const fallback = join(dir, "fallback.log");
  const result = spawnSync("/bin/bash", [RUN_SH, ...args], {
    env: {
      HOME: dir,
      PATH: "/usr/bin:/bin",
      SENTINEL_V5_SPOOL_ROOT: spool,
      SENTINEL_V5_TEST_NOW: testNow,
      SENTINEL_FALLBACK_LOG: fallback,
      ...(override ? { BLT_INTAKE_DOC_REMINDERS_JOB_OVERRIDE: override } : {}),
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  const incoming = join(spool, "incoming");
  const files = existsSync(incoming) ? readdirSync(incoming).filter((n) => n.startsWith(`${ITEM}__`)) : [];
  const payloads = files.map((n) => JSON.parse(readFileSync(join(incoming, n), "utf8")));
  const fallbackLog = existsSync(fallback) ? readFileSync(fallback, "utf8") : "";
  return { result, files, payloads, fallbackLog, spool };
}

function assertSingleCheckin(run, status, reasonCode) {
  assert.equal(run.files.length, 1, `expected exactly one spool file, got ${JSON.stringify(run.files)}; stderr=${run.result.stderr}; fallback=${run.fallbackLog}`);
  const p = run.payloads[0];
  assert.equal(p.item, ITEM);
  assert.equal(p.repo, "blt-intake-doc-reminders");
  assert.equal(p.status, status);
  assert.equal(p.reason_code, reasonCode);
  assert.equal(p.slot, EXPECTED_SLOT);
  assert.equal(p.at, "2026-08-15T21:36:00.000Z");
  assert.equal(p.schema, 2);
}

test("wrapper: clean dry-run checks in green/ok", { skip: !haveNode22 && "node@22 not installed at the pinned path" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "idr-smoke-"));
  try {
    const run = runWrapper({ dir, override: fakeJob(dir) });
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.result.stdout, /fake job args: --dry-run/);
    assertSingleCheckin(run, "green", "ok");
    assert.equal(run.fallbackLog, "", "no producer-side failures logged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper: job that reports an untrusted scrape checks in yellow/degraded", { skip: !haveNode22 && "node@22 not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "idr-smoke-"));
  try {
    const run = runWrapper({ dir, override: fakeJob(dir, { health: "degraded" }) });
    assert.equal(run.result.status, 0, run.result.stderr);
    assertSingleCheckin(run, "yellow", "degraded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper: non-zero job (e.g. TN login failure) checks in red/job_failed and preserves the exit code", { skip: !haveNode22 && "node@22 not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "idr-smoke-"));
  try {
    const run = runWrapper({ dir, override: fakeJob(dir, { rc: 1 }) });
    assert.equal(run.result.status, 1);
    assertSingleCheckin(run, "red", "job_failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper: attestation refusal (no pins, no override) is a REAL red/job_failed check-in, exit 64", { skip: !haveNode22 && "node@22 not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "idr-smoke-"));
  try {
    // No override at all: the wrapper runs its genuine job body, which refuses
    // to start because the head/tree pins are absent — long before Doppler,
    // TherapyNotes, or index.js are touched.
    const run = runWrapper({ dir });
    assert.equal(run.result.status, 64, run.result.stderr);
    assert.match(run.result.stderr, /not pinned/);
    assertSingleCheckin(run, "red", "job_failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper: the job override is ignored without --dry-run (falls through to the real, refusing job body)", { skip: !haveNode22 && "node@22 not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "idr-smoke-"));
  try {
    const run = runWrapper({ dir, args: [], override: fakeJob(dir) });
    assert.equal(run.result.status, 64);
    assert.doesNotMatch(run.result.stdout, /fake job args/);
    assertSingleCheckin(run, "red", "job_failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper: a manual run outside the acceptance window emits nothing and logs why", { skip: !haveNode22 && "node@22 not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "idr-smoke-"));
  try {
    const run = runWrapper({ dir, override: fakeJob(dir), testNow: OUT_OF_WINDOW });
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(run.files.length, 0);
    assert.match(run.fallbackLog, /capture-invocation:idr-hourly-reminders.*stale/);
    assert.match(run.fallbackLog, /no slot captured at invocation start; not emitting/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper source: sentinel capture precedes the job body; job body still attests and uses Doppler", () => {
  const src = readFileSync(RUN_SH, "utf8");
  const captureAt = src.indexOf("sentinel_capture_invocation");
  const jobAt = src.indexOf("run_job()");
  assert.ok(captureAt > 0 && jobAt > captureAt, "capture happens before the job body is defined/run");
  assert.match(src, /verify-runtime-checkout[.]js/);
  assert.match(src, /doppler run --silent --no-fallback/);
  assert.match(src, /sentinel_checkin "\$SENTINEL_ITEM" red job_failed/);
  assert.match(src, /sentinel_checkin "\$SENTINEL_ITEM" yellow degraded/);
  assert.match(src, /sentinel_checkin "\$SENTINEL_ITEM" green ok/);
  assert.doesNotMatch(src, /^\s*exec /m, "the wrapper must not exec away — it has to outlive the job to check in");
});
