"use strict";

// Alert-mail reroute split (2026-08-16): the daily digest is two independent
// sends — a PHI digest to jesse@ (only when there are intakes today) and a
// no-PHI scrape alert to the sentinel mailbox (only when the scrape could not
// be trusted). These tests pin the split decision and that the alert template
// never carries client or clinician identifiers.

const assert = require("node:assert/strict");
const test = require("node:test");
const { digestPlan, digestSuppressible } = require("../index");
const templates = require("../lib/templates");

const TODAY = "2026-08-11";
const TOMORROW = "2026-08-12";
const clean = (grid = []) => ({ grid, ok: true });

test("quiet clean day: neither email goes out (matches the old suppression)", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: clean() };
  const plan = digestPlan({ todayIntakeCount: 0, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW });
  assert.deepEqual(plan, { sendPhiDigest: false, sendScrapeAlert: false });
  assert.equal(digestSuppressible({ todayIntakeCount: 0, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW }), true);
});

test("intakes today, clean scrape: PHI digest only", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: clean() };
  const plan = digestPlan({ todayIntakeCount: 2, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW });
  assert.deepEqual(plan, { sendPhiDigest: true, sendScrapeAlert: false });
});

test("no intakes, dirty scrape day: scrape alert only — a broken scrape never masquerades as quiet", () => {
  const gridByDay = { [TODAY]: clean(), [TOMORROW]: { grid: [], ok: false } };
  const plan = digestPlan({ todayIntakeCount: 0, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW });
  assert.deepEqual(plan, { sendPhiDigest: false, sendScrapeAlert: true });
});

test("missing required day counts as untrustworthy: scrape alert fires", () => {
  const gridByDay = { [TODAY]: clean() }; // tomorrow never scraped
  const plan = digestPlan({ todayIntakeCount: 0, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW });
  assert.deepEqual(plan, { sendPhiDigest: false, sendScrapeAlert: true });
});

test("intakes today AND dirty scrape: both emails go out", () => {
  const gridByDay = { [TODAY]: { grid: [], ok: false }, [TOMORROW]: clean() };
  const plan = digestPlan({ todayIntakeCount: 1, gridByDay, todayYmd: TODAY, tomorrowYmd: TOMORROW });
  assert.deepEqual(plan, { sendPhiDigest: true, sendScrapeAlert: true });
});

test("scrapeAlert template carries dates, counts and flags only — no names by construction", () => {
  const { subject, html } = templates.scrapeAlert({
    ranAt: "Tue, Aug 11, 9:05 AM",
    dateLabel: "Tuesday, Aug 11",
    todayIntakeCount: 3,
    days: [{ ymd: TODAY, ok: false }, { ymd: TOMORROW, ok: true }],
  });
  assert.match(subject, /scrape not fully verified/);
  assert.match(html, /UNPROVABLE/);
  assert.match(html, /Virtual intakes counted today: 3\./);
  // The template's input surface has no client/clinician name fields at all
  // (only ymd + ok flags and a count), so no name can appear. Assert the
  // per-intake doc detail of the PHI digest is absent too.
  assert.doesNotMatch(html, /SOD|GAINSS/);
});
