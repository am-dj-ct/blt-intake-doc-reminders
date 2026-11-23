"use strict";

// The outcome-artifact side channel: a probe reading only launchd's exit
// code cannot tell a quiet zero-intake hour from an hour that silently sent
// nothing it should have. This file is the count a probe compares against
// expectation. Counts only -- no client data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { reportTnSessionFailure, writeRunStatus } = require("../index");

test("writeRunStatus writes counts atomically with a timestamp", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idr-status-"));
  try {
    const file = path.join(dir, "nested", "latest.json");
    writeRunStatus({ candidateCount: 3, virtualIntakeCount: 1, pendingCount: 1, sentCount: 1, scrapeHealth: "ok", health: "green", alertCode: null, zeroIntakeCandidateStreak: 0, cleanupWarning: false }, file);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(written.candidateCount, 3);
    // pendingCount is the count of intakes this run actually needed to act
    // on (excludes ones already handled on an earlier pass) -- the health
    // probe compares sentCount against THIS, not candidateCount, which
    // counts every scraped appointment whether or not it was ever a virtual
    // intake needing a document reminder.
    assert.equal(written.pendingCount, 1);
    assert.equal(written.sentCount, 1);
    assert.equal(written.cleanupWarning, false);
    assert.equal(written.health, "green");
    assert.equal(written.zeroIntakeCandidateStreak, 0);
    assert.equal(typeof written.ranAt, "string");
    // No leftover temp file.
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["latest.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRunStatus is non-fatal when the path cannot be written", () => {
  // Passing a directory as the target file path forces an EISDIR-class
  // failure; the call must warn, not throw.
  assert.doesNotThrow(() => writeRunStatus({ ok: true }, os.tmpdir()));
});

test("a login-stage timeout writes a distinct red status artifact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idr-login-timeout-status-"));
  try {
    const file = path.join(dir, "latest.json");
    const timeout = Object.assign(new Error("synthetic login timeout"), {
      code: "tn_session_stage_timeout",
      alertCode: "tn_login_timeout",
      stage: "login",
      timeoutMs: 75_000,
    });
    const wrapped = new AggregateError([timeout], "synthetic cleanup wrapper", { cause: timeout });
    assert.equal(reportTnSessionFailure(wrapped, file), true);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(written.health, "red");
    assert.equal(written.alertCode, "tn_login_timeout");
    assert.equal(written.stage, "login");
    assert.equal(written.timeoutMs, 75_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("login and timeout failures preserve day evidence without stale counts; intake reset replaces it", t => {
  const { writeTimeoutStatus } = require('../scripts/run-with-timeout');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idr-streak-preserve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'latest.json');
  writeRunStatus({ candidateCount: 10, zeroIntakeCandidateDays: ['2026-11-19', '2026-11-20'], zeroIntakeCandidateStreak: 2, zeroIntakeStreakUnit: 'service_days', zeroIntakeAlertDays: 6 }, file);
  const error = Object.assign(new Error('synthetic timeout'), { alertCode: 'tn_login_timeout' });
  reportTnSessionFailure(error, file);
  let status = JSON.parse(fs.readFileSync(file));
  assert.equal(status.zeroIntakeCandidateStreak, 2);
  assert.deepEqual(status.zeroIntakeCandidateDays, ['2026-11-19', '2026-11-20']);
  assert.equal(status.candidateCount, undefined);
  writeTimeoutStatus(file, 1800);
  status = JSON.parse(fs.readFileSync(file));
  assert.equal(status.alertCode, 'run_timeout');
  assert.equal(status.zeroIntakeCandidateStreak, 2);
  assert.equal(status.zeroIntakeStreakUnit, 'service_days');
  writeRunStatus({ zeroIntakeCandidateDays: [], zeroIntakeCandidateStreak: 0, zeroIntakeStreakUnit: 'service_days', zeroIntakeAlertDays: 6 }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).zeroIntakeCandidateDays, []);
});
