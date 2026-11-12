"use strict";

// Regression for 2026-11-10: a telehealth intake whose grid bubble did not say
// "Virtual"/"Video" was filtered out before its popup was read, so no reminder
// went out. Candidate selection must ignore the grid's modality guess; only
// the popup's Telehealth checkbox decides.

const assert = require("node:assert/strict");
const test = require("node:test");
const { selectCandidates, intakeVerdict } = require("../index");
const tn = require("../lib/tn");

const YMD = "2026-11-10";
// Built through the same local-time parser the job uses, so the test reads the
// same under Pacific time and under CI's TZ=UTC.
const now = tn.parseApptStart(YMD, "8:35 AM");
const windowEnd = new Date(now.getTime() + 30 * 3600 * 1000);
const appt = (over = {}) => ({ clinician: "Ann Bredin", client: "c", time: "4:00 PM", status: "scheduled", modality: "video", aria: "", ...over });

test("a scheduled appointment with no recognised modality on the bubble is still a candidate", () => {
  const grid = [appt({ modality: null }), appt({ modality: "in_person", time: "1:00 PM" }), appt({ modality: "phone", time: "2:00 PM" }), appt({ modality: "video", time: "3:00 PM" })];
  const picked = selectCandidates(grid, YMD, now, windowEnd);
  assert.equal(picked.length, 4);
  assert.ok(picked.every(a => a.start instanceof Date && a.date === YMD));
});

test("cancelled, already-started, out-of-window and unparseable rows are not candidates", () => {
  const grid = [
    appt({ status: "cancelled_or_missed" }),
    appt({ time: "8:00 AM" }),            // already started at 8:35
    appt({ time: "" }),                   // no parseable start
  ];
  assert.equal(selectCandidates(grid, YMD, now, windowEnd).length, 0);
  const tooFar = selectCandidates([appt({ time: "4:00 PM" })], "2026-11-12", now, windowEnd);
  assert.equal(tooFar.length, 0);
});

test("the popup's Telehealth checkbox, not the bubble, decides virtual vs in-person", () => {
  assert.equal(intakeVerdict({ isIntake: true, isTelehealth: true, patientId: "p1" }), "virtual");
  assert.equal(intakeVerdict({ isIntake: true, isTelehealth: false, patientId: "p1" }), "in_person");
  assert.equal(intakeVerdict({ isIntake: false, isTelehealth: true, patientId: "p1" }), null);
  assert.equal(intakeVerdict({ isIntake: true, isTelehealth: true, patientId: null }), null);
  assert.equal(intakeVerdict(null), null);
});
