"use strict";

// The outcome-artifact side channel: a probe reading only launchd's exit
// code cannot tell a quiet zero-intake hour from an hour that silently sent
// nothing it should have. This file is the count a probe compares against
// expectation. Counts only -- no client data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeRunStatus } = require("../index");

test("writeRunStatus writes counts atomically with a timestamp", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idr-status-"));
  try {
    const file = path.join(dir, "nested", "latest.json");
    writeRunStatus({ candidateCount: 3, virtualIntakeCount: 1, pendingCount: 1, sentCount: 1, scrapeHealth: "ok", cleanupWarning: false }, file);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(written.candidateCount, 3);
    // pendingCount is the count of intakes this run actually needed to act
    // on (excludes ones already handled on an earlier pass) -- the health
    // probe compares sentCount against THIS, not candidateCount, which
    // counts every scraped appointment whether or not it was ever a virtual
    // intake needing a document reminder.
    assert.equal(written.pendingCount, 1);
    assert.equal(written.sentCount, 1);
    assert.equal(written.cleanupWarning, false);
    assert.equal(typeof written.ranAt, "string");
    // No leftover temp file.
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["latest.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRunStatus is non-fatal when the path cannot be written", () => {
  // Passing a directory as the target file path forces an EISDIR-class
  // failure; the call must warn, not throw.
  assert.doesNotThrow(() => writeRunStatus({ ok: true }, os.tmpdir()));
});
