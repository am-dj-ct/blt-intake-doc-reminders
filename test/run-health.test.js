"use strict";

// Verdict rules for the scrape-health field recorded in the status artifact
// (data/status/latest.json). Synthetic grid data only — no client data.
const assert = require("node:assert/strict");
const test = require("node:test");
const { runHealthVerdict } = require("../index");

test("a quiet day (both days scraped clean, zero appointments) is ok, not degraded", () => {
  assert.equal(runHealthVerdict({ "2026-08-15": { grid: [], ok: true }, "2026-08-16": { grid: [], ok: true } }), "ok");
});

test("a day that failed to load or was still filtered makes the run degraded", () => {
  assert.equal(runHealthVerdict({ "2026-08-15": { grid: [], ok: true }, "2026-08-16": { grid: [], ok: false } }), "degraded");
  assert.equal(runHealthVerdict({ "2026-08-15": undefined }), "degraded");
});
