"use strict";

// The daily "intake reminder ran and is working" digest is a heartbeat. It must
// stay silent when there is nothing to report, but only when the run can be
// trusted to have seen the whole schedule. These tests pin the decision to
// TODAY's intakes — the digest body only ever describes today, so a tomorrow
// intake (which already fires its own nag/escalation email) must not force a
// "no virtual intakes today" send on a quiet day.

const assert = require("node:assert/strict");
const test = require("node:test");
const { digestSuppressible } = require("../index");

const TODAY = "2026-08-11";
const TOMORROW = "2026-08-12";
const clean = (grid = []) => ({ grid, ok: true });
const video = { status: "scheduled", modality: "video" };

test("suppresses on a quiet day: both days scraped clean, 0 intakes today", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: clean() };
  assert.equal(
    digestSuppressible({ todayIntakeCount: 0, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    true,
  );
});

test("suppresses on a busy telehealth day with 0 intakes (video sessions must not force a send)", () => {
  const gridByDay = {
    [TODAY]: clean(Array(20).fill(video)),
    [TOMORROW]: clean(Array(11).fill(video)),
  };
  assert.equal(
    digestSuppressible({ todayIntakeCount: 0, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    true,
  );
});

test("suppresses when the only in-window intake is tomorrow (its own nag email already fired)", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: clean(Array(3).fill(video)) };
  assert.equal(
    digestSuppressible({ todayIntakeCount: 0, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    true,
  );
});

test("sends when there is an intake today", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: clean() };
  assert.equal(
    digestSuppressible({ todayIntakeCount: 1, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    false,
  );
});

test("sends when a scraped day loaded dirty — a broken scrape must not masquerade as quiet", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: { grid: [], ok: false } };
  assert.equal(
    digestSuppressible({ todayIntakeCount: 0, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    false,
  );
});

test("sends when tomorrow was never scraped at all", () => {
  const gridByDay = { [TODAY]: clean() };
  assert.equal(
    digestSuppressible({ todayIntakeCount: 0, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    false,
  );
});

test("sends when a day-after-tomorrow sliver loaded dirty, even with today+tomorrow clean", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: clean(), "2026-08-13": { grid: [], ok: false } };
  assert.equal(
    digestSuppressible({ todayIntakeCount: 0, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }),
    false,
  );
});
