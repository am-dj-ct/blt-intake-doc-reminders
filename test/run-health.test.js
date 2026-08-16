"use strict";

// The sentinel "degraded" side channel in index.js: verdict rules and the
// health-file write. Synthetic grid data only — no client data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runHealthVerdict, reportRunHealth } = require("../index");

test("a quiet day (both days scraped clean, zero appointments) is ok, not degraded", () => {
  assert.equal(runHealthVerdict({ "2026-08-15": { grid: [], ok: true }, "2026-08-16": { grid: [], ok: true } }), "ok");
});

test("a day that failed to load or was still filtered makes the run degraded", () => {
  assert.equal(runHealthVerdict({ "2026-08-15": { grid: [], ok: true }, "2026-08-16": { grid: [], ok: false } }), "degraded");
  assert.equal(runHealthVerdict({ "2026-08-15": undefined }), "degraded");
});

test("reportRunHealth writes the verdict only when the wrapper asked for it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idr-health-"));
  try {
    const file = path.join(dir, "health");
    reportRunHealth("degraded", { BLT_INTAKE_DOC_REMINDERS_HEALTH_FILE: file });
    assert.equal(fs.readFileSync(file, "utf8"), "degraded\n");
    reportRunHealth("ok", {});
    assert.deepEqual(fs.readdirSync(dir), ["health"]);
    // Unwritable target is non-fatal.
    reportRunHealth("ok", { BLT_INTAKE_DOC_REMINDERS_HEALTH_FILE: path.join(dir, "missing-dir", "health") });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
