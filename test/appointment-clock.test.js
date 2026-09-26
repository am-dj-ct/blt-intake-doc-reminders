"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { appointmentDecision } = require("../index");

test("each appointment refreshes real time while overrides remain fixed", () => {
  const appointment = { start: new Date("2026-09-26T20:00:00.000Z") };
  const readings = [
    new Date("2026-09-26T16:30:00.000Z"),
    new Date("2026-09-26T17:30:00.000Z"),
  ];
  let clockCalls = 0;
  const clock = () => readings[clockCalls++];

  const first = appointmentDecision(appointment, ["SOD"], { date: null }, null, clock);
  const second = appointmentDecision(appointment, ["SOD"], { date: null }, null, clock);
  assert.equal(clockCalls, 2);
  assert.equal(first.hoursToStart, 3.5);
  assert.equal(first.stage, "nag");
  assert.equal(second.hoursToStart, 2.5);
  assert.equal(second.stage, "escalation");

  const fixedNow = new Date("2026-09-26T15:00:00.000Z");
  const fixed = appointmentDecision(appointment, ["SOD"], { date: "2026-09-26" }, fixedNow, () => {
    throw new Error("override must not read the live clock");
  });
  assert.equal(fixed.now, fixedNow);
  assert.equal(fixed.hoursToStart, 5);
  assert.equal(fixed.stage, "nag");
});
