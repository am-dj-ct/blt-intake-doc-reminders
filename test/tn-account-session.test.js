"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const session = require("../lib/tn-account-session");

function resolved(account = "blta") {
  return { account, username: `synthetic-${account}`, password: "synthetic-password", practiceCode: "SYNTHETIC" };
}

function decision(account = "blta", requested = "blta") {
  return {
    account,
    resolved: resolved(account),
    usedFallback: account !== requested,
    lockClass: session.LOCK_CLASS,
  };
}

function fakeBroker(overrides = {}) {
  return {
    doppler: { createDopplerReader: () => async () => "", createDopplerWriter: () => async () => {} },
    resolveAccountForRun: async () => decision(),
    acquireAccountSession: async () => ({ ok: true, verifyStillOwner: () => ({ ok: true }), release: async () => ({ ok: true }) }),
    therapyNotesLoginVisible: async () => false,
    performAccountBrokerLogin: async () => {},
    isTherapyNotesAppUrlFamily: () => true,
    readLoggedInUsername: async () => "synthetic-blta",
    identityGate: { assertIdentity: ({ observedUsername, expectedUsername }) => ({ ok: observedUsername === expectedUsername, reason: "identity_mismatch" }) },
    lock: { killProfileDirAndConfirm: async () => ({ confirmed: true, stillAlive: [] }) },
    ...overrides,
  };
}

test("broker mode is mandatory and legacy opt-out is refused", () => {
  assert.equal(session.isEnabled({}), true);
  assert.equal(session.isEnabled({ TN_ACCOUNT_SYSTEM: "1" }), true);
  assert.throws(() => session.isEnabled({ TN_ACCOUNT_SYSTEM: "0" }), /retired/);
});

test("resolution accepts primary blta and broker fallback blt2", async () => {
  for (const account of ["blta", "blt2"]) {
    let seen;
    const broker = fakeBroker({
      resolveAccountForRun: async (options) => { seen = options; return decision(account); },
    });
    const result = await session.resolveAccount({ env: { TN_ACCOUNT: "blta" }, broker, machine: "Alexs-Mac-mini.local" });
    assert.equal(result.decision.resolved.account, account);
    assert.equal(seen.jobName, session.JOB_NAME);
    assert.equal(seen.accountProfile, session.ACCOUNT_PROFILE);
    assert.equal(seen.registryPath, session.REGISTRY_PATH);
    assert.equal(seen.machine, "Alexs-Mac-mini.local");
  }
});

test("bltj and malformed standard decisions fail before account lock use", async () => {
  for (const malformed of [
    { ...decision("bltj"), account: "bltj" },
    { ...decision("blt2"), account: "blta" },
    { ...decision("blt2"), usedFallback: false },
    { ...decision("blta"), lockClass: "wait-with-timeout" },
  ]) {
    const broker = fakeBroker({ resolveAccountForRun: async () => malformed });
    await assert.rejects(() => session.resolveAccount({ env: { TN_ACCOUNT: "blta" }, broker }), /invalid standard/);
  }
});

test("profile routing is private and limited to the two standard accounts", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "intake-profile-"));
  const profile = session.profileDirFor("blt2", base);
  session.securePathTree(profile);
  assert.equal(profile, path.join(base, "blt2", "browser-profile"));
  assert.equal(fs.statSync(path.join(base, "blt2")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(profile).mode & 0o777, 0o700);
  assert.throws(() => session.profileDirFor("bltj", base), /non-standard/);
});

test("stored sessions skip password submission; fresh sessions use canonical login once", async () => {
  const navigations = [];
  const page = { goto: async (url) => navigations.push(url) };
  let submissions = 0;
  const stored = fakeBroker({ therapyNotesLoginVisible: async () => false });
  assert.deepEqual(await session.ensureLogin({ page, broker: stored, resolved: resolved(), env: {}, dopplerReader: async () => "" }), { freshLogin: false });
  assert.equal(submissions, 0);

  const fresh = fakeBroker({
    therapyNotesLoginVisible: async () => true,
    performAccountBrokerLogin: async (_page, config, target, options) => {
      submissions += 1;
      assert.equal(config.username, "synthetic-blta");
      assert.equal(target, "https://www.therapynotes.com/app/scheduling/");
      assert.equal(options.account, "blta");
      assert.equal(options.isSuccessUrl("https://www.therapynotes.com/app/scheduling/#view=day"), true);
      assert.equal(options.isSuccessUrl("https://www.therapynotes.com/app/patients/"), false);
    },
    isTherapyNotesAppUrlFamily: (value, prefix) => new URL(value).pathname.startsWith(prefix),
  });
  assert.deepEqual(await session.ensureLogin({ page, broker: fresh, resolved: resolved(), env: {}, dopplerReader: async () => "" }), { freshLogin: true });
  assert.equal(submissions, 1);
  assert.equal(navigations.length, 2);
});

test("identity mismatch is a terminal pre-work error", async () => {
  const broker = fakeBroker({ readLoggedInUsername: async () => "different-account" });
  await assert.rejects(() => session.assertIdentityOrThrow({ page: {}, broker, resolved: resolved() }), /identity assertion failed/);
});

test("cleanup confirms context death before releasing the exact lock", async () => {
  const events = [];
  let connected = true;
  const launched = {
    context: { close: async () => { events.push("context-close"); connected = false; } },
    browser: { isConnected: () => connected, close: async () => { events.push("browser-close"); connected = false; } },
  };
  const broker = fakeBroker({ lock: { killProfileDirAndConfirm: async () => { events.push("death-proof"); return { confirmed: true, stillAlive: [] }; } } });
  const lockSession = { release: async () => { events.push("release"); return { ok: true }; } };
  const profileDir = session.profileDirFor("blta", fs.mkdtempSync(path.join(os.tmpdir(), "intake-cleanup-")));
  session.securePathTree(profileDir);
  const result = await session.cleanupAndRelease({ launched, profileDir, lockSession, broker, timeoutMs: 20 });
  assert.equal(result.confirmed, true);
  assert.deepEqual(events, ["context-close", "death-proof", "release"]);
});

test("unconfirmed browser death leaves the account lock held", async () => {
  let released = false;
  const launched = {
    context: { close: async () => {} },
    browser: { isConnected: () => true, close: async () => {} },
  };
  const broker = fakeBroker({ lock: { killProfileDirAndConfirm: async () => ({ confirmed: false, stillAlive: [12345] }) } });
  const profileDir = session.profileDirFor("blta", fs.mkdtempSync(path.join(os.tmpdir(), "intake-unconfirmed-")));
  session.securePathTree(profileDir);
  const result = await session.cleanupAndRelease({
    launched,
    profileDir,
    broker,
    lockSession: { release: async () => { released = true; return { ok: true }; } },
    timeoutMs: 5,
  });
  assert.equal(result.confirmed, false);
  assert.equal(released, false);
});

test("a graceful-close error stays visible and cannot authorize failover", async () => {
  let connected = true;
  let released = false;
  const launched = {
    context: { close: async () => { throw new Error("close failed"); } },
    browser: { isConnected: () => connected, close: async () => { connected = false; } },
  };
  const broker = fakeBroker({ lock: { killProfileDirAndConfirm: async () => ({ confirmed: true, stillAlive: [] }) } });
  const profileDir = session.profileDirFor("blta", fs.mkdtempSync(path.join(os.tmpdir(), "intake-close-failed-")));
  session.securePathTree(profileDir);
  const result = await session.cleanupAndRelease({
    launched,
    profileDir,
    broker,
    lockSession: { release: async () => { released = true; return { ok: true }; } },
  });
  assert.equal(released, true);
  assert.equal(result.confirmed, false);
});

test("only confirmed fresh-login rejection is eligible for same-run failover", () => {
  assert.equal(session.retryableFreshLoginRejection({ code: "tn_account_prework_unavailable", loginOutcome: "confirmed_rejection" }), true);
  for (const error of [
    { code: "tn_account_prework_unavailable", loginOutcome: "post_submit_ambiguous" },
    { code: "identity_mismatch", loginOutcome: "confirmed_rejection" },
    new Error("ordinary failure"),
  ]) assert.equal(session.retryableFreshLoginRejection(error), false);
});
