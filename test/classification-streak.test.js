"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { classificationSignal, reportClassificationHealth } = require("../index");
const { ZERO_INTAKE_ALERT_DAYS } = require("../config");
const scan = (days, previous = null, intakeCount = 0) => classificationSignal({ candidateServiceDays: days, candidateCount: days.length * 10, intakeCount }, previous);

test("hourly runs across one intake-free service day stay ok", () => {
  let status = null;
  for (let hour = 7; hour <= 20; hour++) {
    status = scan(["2026-11-23"], status);
    assert.equal(status.health, "ok");
    assert.equal(status.zeroIntakeCandidateStreak, 1);
  }
  assert.deepEqual(status.zeroIntakeCandidateDays, ["2026-11-23"]);
});

test("six distinct candidate-bearing service days go red; overlapping windows count once", () => {
  assert.equal(ZERO_INTAKE_ALERT_DAYS, 6);
  let status = null;
  for (let day = 1; day <= 6; day++) {
    status = scan([`2026-12-0${day}`, `2026-12-0${day}`], status);
    assert.equal(status.zeroIntakeCandidateStreak, day);
    assert.equal(status.health, day < 6 ? "ok" : "red");
  }
  assert.equal(status.alertCode, "candidates_zero_intakes_streak");
  assert.equal(status.zeroIntakeStreakUnit, "service_days");
  assert.equal(status.zeroIntakeAlertDays, 6);
});

test("empty hours and nonworking days preserve evidence; any intake resets", () => {
  let status = scan(["2026-11-19", "2026-11-20"]);
  status = scan([], status);
  assert.equal(status.zeroIntakeCandidateStreak, 2);
  status = scan(["2026-11-23"], status);
  assert.equal(status.zeroIntakeCandidateStreak, 3);
  for (const intakeCount of [1, 2]) {
    const reset = scan(["2026-11-23"], status, intakeCount);
    assert.equal(reset.zeroIntakeCandidateStreak, 0);
    assert.deepEqual(reset.zeroIntakeCandidateDays, []);
    assert.equal(reset.health, "ok");
    assert.equal(reset.alertCode, null);
  }
});

test("legacy hourly streak is discarded on migration", () => {
  const status = scan(["2026-11-23"], { zeroIntakeCandidateStreak: 99 });
  assert.equal(status.zeroIntakeCandidateStreak, 1);
  assert.equal(status.health, "ok");
});

test("classification red uses existing wrapper health channel", t => {
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'idr-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = require('node:path').join(dir, 'health');
  const env = { BLT_INTAKE_DOC_REMINDERS_HEALTH_FILE: file };
  reportClassificationHealth({ health: 'green', alertCode: null }, env);
  assert.equal(fs.existsSync(file), false);
  reportClassificationHealth({ health: 'red', alertCode: 'candidates_zero_intakes_streak' }, env);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'red');
});
