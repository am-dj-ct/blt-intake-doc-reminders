"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { openTnSession } = require("../index");

function preworkError(account, outcome = "confirmed_rejection") {
  const error = new Error(`synthetic ${outcome}`);
  error.code = "tn_account_prework_unavailable";
  error.loginOutcome = outcome;
  error.tnAccount = account;
  error.tnCleanupConfirmed = false;
  return error;
}

function canonicalFailover(events) {
  return {
    withPreWorkAccountFailover: async (runAttempt) => {
      const failed = new Set();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return await runAttempt({ attempt }); }
        catch (error) {
          const safe = error.code === "tn_account_prework_unavailable" && error.tnCleanupConfirmed === true &&
            ["blta", "blt2"].includes(error.tnAccount) && !failed.has(error.tnAccount);
          if (!safe || attempt === 1) throw error;
          failed.add(error.tnAccount);
          events.push(`retry-after:${error.tnAccount}`);
        }
      }
      throw new Error("unreachable");
    },
    confirmPreWorkFailoverCleanup: (error, account) => {
      events.push(`confirm-cleanup:${account}`);
      if (error.code === "tn_account_prework_unavailable" && error.tnAccount === account) error.tnCleanupConfirmed = true;
    },
  };
}

function harness({ accounts = ["blta"], loginFailures = [], identityFailure, busy = false, cleanupConfirmed = true } = {}) {
  const events = [];
  let resolution = 0;
  const broker = canonicalFailover(events);
  const tn = {
    launch: async ({ profileDir }) => {
      events.push(`launch:${profileDir}`);
      return { page: {}, context: {}, browser: {} };
    },
  };
  const tnAccountSession = {
    isEnabled: () => true,
    resolveAccount: async () => {
      const account = accounts[Math.min(resolution, accounts.length - 1)];
      resolution += 1;
      events.push(`resolve:${account}`);
      return { decision: { account, resolved: { account, username: `synthetic-${account}` } }, dopplerReader: async () => "" };
    },
    profileDirFor: (account) => `/synthetic/profiles/${account}/browser-profile`,
    acquireSession: async ({ account, browserProfileDir }) => {
      events.push(`acquire:${account}:${browserProfileDir}`);
      if (busy) return { ok: false, reason: "busy" };
      return { ok: true, verifyStillOwner: () => ({ ok: true }), release: async () => ({ ok: true }) };
    },
    securePathTree: (profile) => events.push(`secure:${profile}`),
    ensureLogin: async ({ resolved }) => {
      events.push(`login:${resolved.account}`);
      const failure = loginFailures[resolution - 1];
      if (failure) throw failure;
    },
    assertIdentityOrThrow: async ({ resolved }) => {
      events.push(`identity:${resolved.account}`);
      if (identityFailure) throw identityFailure;
    },
    cleanupAndRelease: async ({ profileDir }) => {
      events.push(`cleanup:${profileDir}`);
      return cleanupConfirmed ? { confirmed: true } : { confirmed: false, error: new Error("cleanup failed") };
    },
    retryableFreshLoginRejection: (error) => error.code === "tn_account_prework_unavailable" && error.loginOutcome === "confirmed_rejection",
  };
  return {
    events,
    deps: { env: { TN_ACCOUNT_SYSTEM: "1", TN_ACCOUNT: "blta" }, broker, tn, tnAccountSession },
    resolutions: () => resolution,
  };
}

test("a successful primary session opens under blta and cleans up once", async () => {
  const lane = harness();
  const opened = await openTnSession({}, lane.deps);
  assert.equal(opened.account, "blta");
  await opened.release();
  await opened.release();
  assert.equal(lane.resolutions(), 1);
  assert.deepEqual(lane.events, [
    "resolve:blta",
    "acquire:blta:/synthetic/profiles/blta/browser-profile",
    "secure:/synthetic/profiles/blta/browser-profile",
    "launch:/synthetic/profiles/blta/browser-profile",
    "login:blta",
    "identity:blta",
    "cleanup:/synthetic/profiles/blta/browser-profile",
  ]);
});

test("confirmed fresh-login rejection retries once on blt2 only after cleanup", async () => {
  const lane = harness({
    accounts: ["blta", "blt2"],
    loginFailures: [preworkError("blta"), null],
  });
  const opened = await openTnSession({}, lane.deps);
  assert.equal(opened.account, "blt2");
  const cleanupIndex = lane.events.indexOf("cleanup:/synthetic/profiles/blta/browser-profile");
  const retryIndex = lane.events.indexOf("retry-after:blta");
  const secondResolveIndex = lane.events.indexOf("resolve:blt2");
  assert.ok(cleanupIndex >= 0 && cleanupIndex < retryIndex && retryIndex < secondResolveIndex);
  assert.equal(lane.resolutions(), 2);
  await opened.release();
});

test("busy is a clean skip and never resolves or launches a second account", async () => {
  const lane = harness({ accounts: ["blta", "blt2"], busy: true });
  const result = await openTnSession({}, lane.deps);
  assert.deepEqual(result, { skip: true, reason: "busy" });
  assert.equal(lane.resolutions(), 1);
  assert.equal(lane.events.some((event) => event.startsWith("launch:")), false);
});

test("cleanup failure blocks fresh-login failover", async () => {
  const lane = harness({
    accounts: ["blta", "blt2"],
    loginFailures: [preworkError("blta"), null],
    cleanupConfirmed: false,
  });
  await assert.rejects(() => openTnSession({}, lane.deps), AggregateError);
  assert.equal(lane.resolutions(), 1);
  assert.equal(lane.events.some((event) => event.startsWith("retry-after:")), false);
});

test("ambiguous post-submit failure never retries", async () => {
  const lane = harness({
    accounts: ["blta", "blt2"],
    loginFailures: [preworkError("blta", "post_submit_ambiguous"), null],
  });
  await assert.rejects(() => openTnSession({}, lane.deps), /post_submit_ambiguous/);
  assert.equal(lane.resolutions(), 1);
});

test("identity failure cleans up but never retries", async () => {
  const lane = harness({ accounts: ["blta", "blt2"], identityFailure: new Error("identity mismatch") });
  await assert.rejects(() => openTnSession({}, lane.deps), /identity mismatch/);
  assert.equal(lane.resolutions(), 1);
  assert.equal(lane.events.includes("cleanup:/synthetic/profiles/blta/browser-profile"), true);
  assert.equal(lane.events.some((event) => event.startsWith("retry-after:")), false);
});

test("post-open work failure cannot enter the pre-work failover wrapper", async () => {
  const lane = harness({ accounts: ["blta", "blt2"] });
  const opened = await openTnSession({}, lane.deps);
  await assert.rejects(async () => {
    try { throw new Error("synthetic postwork failure"); }
    finally { await opened.release(); }
  }, /postwork failure/);
  assert.equal(lane.resolutions(), 1);
});

test("legacy account-system opt-out fails before broker or browser work", async () => {
  let browserTouched = false;
  const tnAccountSession = { isEnabled: () => { throw new Error("Unbrokered TherapyNotes mode is retired."); } };
  await assert.rejects(() => openTnSession({}, {
    env: { TN_ACCOUNT_SYSTEM: "0" },
    tnAccountSession,
    tn: { launch: async () => { browserTouched = true; } },
  }), /retired/);
  assert.equal(browserTouched, false);
});
