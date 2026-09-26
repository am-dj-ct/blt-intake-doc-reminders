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
    if (outcome === "busy") return `${head}\n[skip] TN account busy (skip-if-busy lock, reason=busy) — skipping\n\nDone.\n`;
    if (outcome === "timeout") return `${head}[timeout] run exceeded 1800s; terminating its process group\n`;
    return `${head}FAILED: synthetic failure\n`;
  }).join("");
}

function watch(outcomes, now = "2026-09-28T21:00:00-07:00") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idr-watch-"));
  const log = path.join(dir, "run.log");
  fs.writeFileSync(log, runLog(outcomes));
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
  const three = { ...two, 16: "busy" };
  const r = watch(three);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /3 of 14 hourly runs today failed/);
  assert.match(r.stdout, /dry run, no email/);
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
