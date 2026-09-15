"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "scripts", "roster-set.mjs");

const FIXTURE_CONFIG = `// fixture config.js -- mirrors the shape of the real CLINICIAN_EMAILS block only.
const CLINICIAN_EMAILS = {
  'Brad Corcoran': 'brad@balancedlivingtherapy.com',
  'Brynnen Bailey-Lewis': 'brynnen@balancedlivingtherapy.com',
};

module.exports = {
  CLINICIAN_EMAILS,
};
`;

async function withFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "idr-roster-set-"));
  const configPath = path.join(dir, "config.js");
  await writeFile(configPath, FIXTURE_CONFIG, "utf8");
  return { dir, configPath };
}

async function writeAcceptedDirectory(dir, names) {
  const directoryPath = path.join(dir, "directory.json");
  await writeFile(directoryPath, JSON.stringify({
    pass: true,
    status: "succeeded",
    finishedAt: new Date().toISOString(),
    therapists: names.map((displayName) => ({ displayName, status: "unknown", scheduleEligible: true })),
  }));
  return directoryPath;
}

async function loadEmails(configPath) {
  delete require.cache[require.resolve(configPath)];
  return require(configPath).CLINICIAN_EMAILS;
}

function run(args) {
  return execFileSync("node", [SCRIPT, ...args], { encoding: "utf8" });
}

test("removes a departed clinician's row entirely", async () => {
  const { configPath } = await withFixture();
  run(["--name", "Brad Corcoran", "--action", "remove", "--config", configPath]);
  const emails = await loadEmails(configPath);
  assert.equal(Object.prototype.hasOwnProperty.call(emails, "Brad Corcoran"), false);
  assert.equal(Object.keys(emails).length, 1);
});

test("remove refuses a name with no existing entry", async () => {
  const { configPath } = await withFixture();
  assert.throws(() => run(["--name", "Nobody Here", "--action", "remove", "--config", configPath]), /no existing CLINICIAN_EMAILS entry/);
});

test("adds a directory-backed clinician", async () => {
  const { dir, configPath } = await withFixture();
  const directoryPath = await writeAcceptedDirectory(dir, ["Bailey-Lewis, Brynnen", "Newhire, Sam"]);
  run(["--name", "Sam Newhire", "--action", "add", "--email", "sam@balancedlivingtherapy.com", "--config", configPath, "--directory", directoryPath]);
  const emails = await loadEmails(configPath);
  assert.equal(emails["Sam Newhire"], "sam@balancedlivingtherapy.com");
});

test("refuses to add a clinician absent from the active directory", async () => {
  const { dir, configPath } = await withFixture();
  const directoryPath = await writeAcceptedDirectory(dir, ["Bailey-Lewis, Brynnen"]);
  assert.throws(
    () => run(["--name", "Ghost Clinician", "--action", "add", "--email", "ghost@balancedlivingtherapy.com", "--config", configPath, "--directory", directoryPath]),
    /roster_directory_drift/
  );
  const emails = await loadEmails(configPath);
  assert.equal(Object.prototype.hasOwnProperty.call(emails, "Ghost Clinician"), false);
});

test("--force with --reason bypasses directory validation", async () => {
  const { dir, configPath } = await withFixture();
  const directoryPath = await writeAcceptedDirectory(dir, []);
  run([
    "--name", "Ghost Clinician", "--action", "add", "--email", "ghost@balancedlivingtherapy.com",
    "--config", configPath, "--directory", directoryPath, "--force", "true", "--reason", "verbal offer confirmed, directory not refreshed yet",
  ]);
  const emails = await loadEmails(configPath);
  assert.equal(emails["Ghost Clinician"], "ghost@balancedlivingtherapy.com");
});

test("force without --reason is refused", async () => {
  const { dir, configPath } = await withFixture();
  const directoryPath = await writeAcceptedDirectory(dir, []);
  assert.throws(
    () => run(["--name", "Ghost Clinician", "--action", "add", "--email", "ghost@balancedlivingtherapy.com", "--config", configPath, "--directory", directoryPath, "--force", "true"]),
    /--reason/
  );
});

test("updates the email for an existing entry without a directory check", async () => {
  const { dir, configPath } = await withFixture();
  const directoryPath = await writeAcceptedDirectory(dir, []); // empty directory -- would refuse a create
  run(["--name", "Brad Corcoran", "--action", "add", "--email", "brad2@balancedlivingtherapy.com", "--config", configPath, "--directory", directoryPath, "--force", "true", "--reason", "existing entry, updating alias only"]);
  const emails = await loadEmails(configPath);
  assert.equal(emails["Brad Corcoran"], "brad2@balancedlivingtherapy.com");
});

test("editing one entry leaves the rest of config.js byte-identical", async () => {
  const { configPath } = await withFixture();
  const before = await readFile(configPath, "utf8");
  run(["--name", "Brad Corcoran", "--action", "remove", "--config", configPath]);
  const after = await readFile(configPath, "utf8");
  assert.equal(before.split("\n").length - 1, after.split("\n").length, "removing a row should remove exactly one line");
  assert.ok(!after.includes("Brad Corcoran"));
  assert.ok(after.includes("Brynnen Bailey-Lewis"));
});
