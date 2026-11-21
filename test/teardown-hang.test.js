"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { runBoundedCleanup, installBoundedProfileCleanup } = require("../lib/bounded-profile-cleanup");
const { securePathTree } = require("../lib/tn-account-session");

test("hung browser closes and transport still exit after browser death and exact lock release", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idr-teardown-"));
  const profile = path.join(dir, "account", "browser-profile");
  const lock = path.join(dir, "lock");
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.writeFileSync(lock, "synthetic owner");
  const code = `
    const fs = require('node:fs');
    const { cleanupAndRelease } = require('./lib/tn-account-session');
    const { finishSuccessfulRun } = require('./lib/finish-run');
    // Reproduce the leaked Playwright transport handle, not just a Promise.
    setInterval(() => {}, 1000);
    const never = () => new Promise(() => {});
    cleanupAndRelease({
      launched: { context: { close: never }, browser: { isConnected: () => true, close: never } },
      profileDir: process.argv[1], timeoutMs: 15,
      broker: { lock: { killProfileDirAndConfirm: async () => ({ confirmed: true, stillAlive: [] }) } },
      lockSession: { verifyStillOwner: () => ({ ok: true }), release: async () => {
        fs.unlinkSync(process.argv[2]); return { ok: true };
      } }
    }).then(result => {
      if (!result.safeToClose || !result.released) process.exit(9);
      console.log('Done. lockReleased=true'); finishSuccessfulRun();
    }).catch(() => process.exit(8));
  `;
  try {
    const result = spawnSync(process.execPath, ["-e", code, profile, lock], {
      cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Done\. lockReleased=true/);
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("synchronous reseal that never returns is killed before canonical release can proceed", () => {
  let released = false;
  let childPid;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idr-seal-hang-"));
  const pidFile = path.join(dir, "pid");
  try {
    const started = Date.now();
    assert.throws(() => {
      runBoundedCleanup("seal", {}, {
        timeoutMs: 200,
        execute: (_exe, _args, options) => execFileSync(process.execPath,
          ["-e", "require('fs').writeFileSync(process.argv[1],String(process.pid)); while(true) {}", pidFile], options),
      });
      released = true;
    }, (error) => error.alertCode === "tn_profile_cleanup_timeout");
    assert.equal(released, false);
    childPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    assert.ok(Date.now() - started < 3000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bounded sealing wraps the original broker object rather than replacing canonical release", () => {
  const envelope = { refreshSessionEnvelope() {}, ensureSessionEnvelope() {} };
  const original = envelope.refreshSessionEnvelope;
  const release = () => {};
  const broker = { sessionEnvelope: envelope, acquireAccountSession: () => ({ release }) };
  const secure = installBoundedProfileCleanup(broker, "/synthetic");
  assert.notEqual(envelope.refreshSessionEnvelope, original);
  assert.equal(broker.acquireAccountSession().release, release);
  assert.equal(typeof secure.secureProfileForRelease, "function");
});

test("cache retirement preserves authentication state and refuses symlinked ancestors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idr-cache-"));
  const profile = path.join(dir, "account", "browser-profile");
  securePathTree(profile, { lockOwnershipVerified: true });
  const defaultDir = path.join(profile, "Default");
  const cache = path.join(defaultDir, "Cache");
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cache, "synthetic-cache"), "cache");
  fs.writeFileSync(path.join(defaultDir, "Cookies"), "synthetic bearer");
  try {
    securePathTree(profile, { lockOwnershipVerified: true, discardDiskCache: true });
    assert.equal(fs.existsSync(cache), false);
    assert.equal(fs.readFileSync(path.join(defaultDir, "Cookies"), "utf8"), "synthetic bearer");
    fs.symlinkSync(dir, cache);
    assert.throws(() => securePathTree(profile, { lockOwnershipVerified: true, discardDiskCache: true }), /cache path/);
    assert.equal(fs.existsSync(path.join(defaultDir, "Cookies")), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
