"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("the only browser launch uses the broker-selected persistent profile", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "tn.js"), "utf8");
  const launch = source.match(/async function launch[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(launch, /if \(!profileDir\).*broker-selected TherapyNotes profile/);
  assert.match(launch, /launchPersistentContext\(profileDir/);
  assert.doesNotMatch(launch, /chromium[.]launch\(/);
});

test("every browser-capable helper uses the same brokered session seam", () => {
  const root = path.join(__dirname, "..");
  for (const relative of ["scripts/inspect-tn.js", "scripts/debug-login.js", "scripts/check-docs.js"]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.match(source, /openTnSession/);
    assert.doesNotMatch(source, /tn[.]launch|tn[.]login|loadCreds|TN_(USERNAME|PASSWORD|PRACTICE_CODE)/);
  }
  const tnSource = fs.readFileSync(path.join(root, "lib", "tn.js"), "utf8");
  assert.doesNotMatch(tnSource, /loadCreds|THERAPY_HOURS_TN_USERNAME|process[.]env[.]TN_PASSWORD/);
});
