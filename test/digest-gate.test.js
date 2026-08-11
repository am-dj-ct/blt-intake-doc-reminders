"use strict";

// The daily "intake reminder ran and is working" digest is a heartbeat. It must
// stay silent when there is nothing to report, but only when the run can be
// trusted to have seen the whole schedule. These tests pin the decision to
// INTAKES, not to raw video-appointment counts — the bug that made the digest
// email every single weekday even with zero intakes.

const assert = require("node:assert/strict");
const test = require("node:test");
const { digestSuppressible } = require("../index");

const TODAY = "2026-08-11";
const TOMORROW = "2026-08-12";
const clean = (grid = []) => ({ grid, ok: true });
const video = { status: "scheduled", modality: "video" };

test("suppresses on a quiet day: both days scraped clean, 0 intakes, 0 missing", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: clean() };
  assert.equal(
    digestSuppressible({ intakeCount: 0, missingDocs: false, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    true,
  );
});

test("suppresses on a busy telehealth day with 0 intakes (the bug: video sessions must not force a send)", () => {
  const gridByDay = {
    [TODAY]: clean(Array(20).fill(video)),
    [TOMORROW]: clean(Array(11).fill(video)),
  };
  assert.equal(
    digestSuppressible({ intakeCount: 0, missingDocs: false, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    true,
  );
});

test("sends when there is an intake in the window", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: clean() };
  assert.equal(
    digestSuppressible({ intakeCount: 1, missingDocs: false, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    false,
  );
});

test("sends when a doc is missing even if the intake count reads 0", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: clean() };
  assert.equal(
    digestSuppressible({ intakeCount: 0, missingDocs: true, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    false,
  );
});

test("sends when a scraped day loaded dirty — a broken scrape must not masquerade as quiet", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: { grid: [], ok: false } };
  assert.equal(
    digestSuppressible({ intakeCount: 0, missingDocs: false, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    false,
  );
});

test("sends when tomorrow was never scraped at all", () => {
  const gridByDay = { [TODAY]: clean() };
  assert.equal(
    digestSuppressible({ intakeCount: 0, missingDocs: false, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    false,
  );
});

test("sends when a day-after-tomorrow sliver loaded dirty, even with today+tomorrow clean", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: clean(), "2026-08-13": { grid: [], ok: false } };
  assert.equal(
    digestSuppressible({ intakeCount: 0, missingDocs: false, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    false,
  );
});
