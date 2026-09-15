"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  activeDirectoryKeys,
  assertNameInDirectory,
  loadAcceptedDirectory,
  nameKey,
  normalizeDisplayName,
} = require("../lib/roster-directory");

test("normalizeDisplayName flips \"Last, First\" to \"First Last\"", () => {
  assert.equal(normalizeDisplayName("Bailey-Lewis, Brynnen"), "Brynnen Bailey-Lewis");
  assert.equal(normalizeDisplayName("Brynnen Bailey-Lewis"), "Brynnen Bailey-Lewis");
});

test("activeDirectoryKeys drops removed, inactive-status, and schedule-ineligible rows", () => {
  const keys = activeDirectoryKeys([
    { displayName: "Bailey-Lewis, Brynnen", status: "unknown", scheduleEligible: true },
    { displayName: "Departed, Clinician", status: "terminated", scheduleEligible: true },
    { displayName: "Removed, Clinician", status: "unknown", removedAt: "2026-01-01T00:00:00Z" },
    { displayName: "Ineligible, Clinician", status: "unknown", scheduleEligible: false },
  ]);
  assert.deepEqual([...keys], [nameKey("Bailey-Lewis, Brynnen")]);
});

test("assertNameInDirectory refuses a name absent from the active set", () => {
  assert.throws(
    () => assertNameInDirectory("Claire Popke", [{ displayName: "Bailey-Lewis, Brynnen", status: "unknown" }]),
    /roster_directory_drift/
  );
});

test("loadAcceptedDirectory rejects a stale snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "idr-roster-directory-"));
  const file = path.join(dir, "directory.json");
  await writeFile(file, JSON.stringify({
    pass: true,
    status: "succeeded",
    finishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    therapists: [{ displayName: "Bailey-Lewis, Brynnen", status: "unknown" }],
  }));
  await assert.rejects(loadAcceptedDirectory(file), /stale/);
});
