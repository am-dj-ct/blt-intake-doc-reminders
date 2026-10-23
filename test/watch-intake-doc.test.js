"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "watch-intake-doc.sh");

// Synthetic run log: one header per hourly slot on 2026-09-28 (PDT = UTC-7).
function runLog(outcomes) {
  return Object.entries(outcomes).map(([hour, outcome]) => {
    const utc = new Date(`2026-09-28T${String(hour).padStart(2, "0")}:36:00-07:00`).toISOString();
    const head = `=== BLT intake-doc reminder — now=${utc} window=30h  ===\n`;
    if (outcome === "ok") return `${head}Virtual intakes in window: 0\n\nDone.\n`;
    // A clean run that saw an intake still missing documents (synthetic names).
    if (outcome === "pending") return `${head}Virtual intakes in window: 1\n\nTest Client — Test Clinician — Mon 9/28 4:00 PM (5.0h) | docs: missing SOD+GAINSS\n  [skip] nag — already sent for Test Client\n\nDone.\n`;
    if (outcome === "complete") return `${head}Virtual intakes in window: 1\n\nTest Client — Test Clinician — Mon 9/28 4:00 PM (5.0h) | docs: all present\n  [skip] confirm — already sent for Test Client\n\nDone.\n`;
    if (outcome === "busy") return `${head}\n[skip] TN account busy (skip-if-busy lock, reason=busy) — skipping\n\nDone.\n`;
    if (outcome === "timeout") return `${head}[timeout] run exceeded 1800s; terminating its process group\n`;
    return `${head}FAILED: synthetic failure\n`;
  }).join("");
}

// The previous evening's last run (2026-09-27 20:35 PDT), clean, nothing waiting.
const LAST_NIGHT_CLEAN = "=== BLT intake-doc reminder — now=2026-09-28T03:36:00.000Z window=30h  ===\nVirtual intakes in window: 0\n\nDone.\n";

function watch(outcomes, now = "2026-09-28T21:00:00-07:00", prefix = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idr-watch-"));
  const log = path.join(dir, "run.log");
  fs.writeFileSync(log, prefix + runLog(outcomes));
  const r = spawnSync("/bin/bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, IDR_WATCH_RUN_LOG: log, IDR_WATCH_NOW: now, IDR_WATCH_DRY: "1" },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

const allOk = () => Object.fromEntries(Array.from({ length: 14 }, (_, i) => [i + 7, "ok"]));

test("a full clean day stays silent", () => {
  const r = watch(allOk());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /14 of 14 hourly runs clean today/);
});

test("two bad hours stay silent, three alert", () => {
  const two = { ...allOk(), 9: "failed", 14: "timeout" };
  assert.equal(watch(two).status, 0);
  const three = { ...two, 15: "pending", 16: "busy" };
  const r = watch(three);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /3 of 14 hourly runs today failed/);
  assert.match(r.stdout, /dry run, no email/);
});

test("busy skips with nothing waiting stay silent", () => {
  // The 2026-10-22 shape: four morning busy skips, the rest clean, no intake
  // missing documents anywhere.
  const r = watch({ ...allOk(), 7: "busy", 8: "busy", 9: "busy", 10: "busy" }, undefined, LAST_NIGHT_CLEAN);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /10 of 14 hourly runs clean today, 4 busy skip\(s\) with nothing waiting/);
});

test("busy skips after a run whose intake had all documents stay silent", () => {
  const r = watch({ ...allOk(), 9: "complete", 10: "busy", 11: "busy", 12: "busy" });
  assert.equal(r.status, 0);
});

test("busy skips after a missing-docs run alert", () => {
  // The 2026-10-20 shape: an intake still missing documents, then busy skips.
  const r = watch({ ...allOk(), 9: "pending", 10: "busy", 11: "busy", 12: "busy", 13: "complete" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /3 of 14 hourly runs today failed, timed out, skipped while an intake was waiting, or never ran \(11 ok\)/);
});

test("a clean run with nothing missing clears the waiting state", () => {
  // Skips after the 9:35 pending run count; skips after the 13:35 complete run do not.
  const r = watch({ ...allOk(), 9: "pending", 10: "busy", 11: "busy", 13: "complete", 14: "busy", 15: "busy" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /10 of 14 hourly runs clean today, 2 busy skip\(s\) with nothing waiting/);
});

test("a failed run does not clear the waiting state", () => {
  // 10:35 fails, so 11:35 and 12:35 still look back to the 9:35 pending run.
  const r = watch({ ...allOk(), 9: "pending", 10: "failed", 11: "busy", 12: "busy" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /3 of 14/);
});

test("busy skips with no clean run before them count as bad", () => {
  const r = watch({ 7: "busy", 8: "busy", 9: "busy", 10: "ok" }, "2026-09-28T11:00:00-07:00");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /3 of 4/);
});

test("a day of only harmless busy skips still trips the zero-clean rule", () => {
  // Last night's run was clean with nothing waiting; today every slot skipped.
  const r = watch({ 7: "busy", 8: "busy", 9: "busy" }, "2026-09-28T10:00:00-07:00", LAST_NIGHT_CLEAN);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no hourly run finished cleanly today \(0 of 3 slots\)/);
});

test("slots that never ran count as missed", () => {
  const outcomes = allOk();
  delete outcomes[8]; delete outcomes[12]; delete outcomes[19];
  const r = watch(outcomes);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /3 of 14/);
});

test("no clean run at all alerts", () => {
  const r = watch({ 7: "failed", 8: "timeout" }, "2026-09-28T09:00:00-07:00");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no hourly run finished cleanly today \(0 of 2 slots\)/);
});

test("yesterday's clean runs do not count for today", () => {
  const r = watch(allOk(), "2026-09-29T21:00:00-07:00");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /0 of 14 slots/);
});
