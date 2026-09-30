"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { openTnSession, isTransientPreWorkTimeout } = require("../index");

function preworkError(account, outcome = "confirmed_rejection") {
  const error = new Error(`synthetic ${outcome}`);
  error.code = "tn_account_prework_unavailable";
  error.loginOutcome = outcome;
  error.tnAccount = account;
  error.tnCleanupConfirmed = false;
  return error;
}

// Matches lib/tn-account-session.js's boundedSessionStage synthetic timeout
// for the "login" stage — this is exactly the shape of the first 2026-09-26
// production failure ("TherapyNotes login timed out after 180000ms").
function loginStageTimeoutError() {
  const error = new Error("TherapyNotes login timed out after 180000ms.");
  error.code = "tn_session_stage_timeout";
  error.stage = "login";
  error.alertCode = "tn_login_timeout";
  return error;
}

// Matches Playwright's own page.goto navigation timeout, raised inside
// ensureLogin before the stage timeout would fire — the shape of the second
// 2026-09-26 production failure.
function pageGotoTimeoutError() {
  return new Error("page.goto: Timeout 30000ms exceeded.");
}

function identityReadError() {
  const error = new Error('TN identity assertion failed for account "blta": identity_read_error');
  error.code = "tn_identity_transient_read_error";
  error.alertCode = "tn_identity_read_error";
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

function harness({ accounts = ["blta"], acquireFailures = [], loginFailures = [], launchFailures = [], identityFailure, identityFailures = [], busy = false, cleanupConfirmed = true, cleanupSafeToClose = false } = {}) {
  const events = [];
  let resolution = 0;
  const broker = canonicalFailover(events);
  const tn = {
    launch: async ({ profileDir }) => {
      events.push(`launch:${profileDir}`);
      const failure = launchFailures.shift();
      if (failure) throw failure;
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
    acquireSession: async ({ account, browserProfileDir, recoverStaleEnvelope }) => {
      events.push(`acquire:${account}:${browserProfileDir}`);
      if (busy) return { ok: false, reason: "busy" };
      const failure = acquireFailures.shift();
      if (failure) throw failure;
      if (recoverStaleEnvelope) events.push(`quarantine:${browserProfileDir}`);
      events.push(`secure:${browserProfileDir}`);
      return {
        ok: true,
        verifyStillOwner: () => { events.push(`owner-check:${account}`); return { ok: true }; },
        release: async () => ({ ok: true }),
      };
    },
    // Mirrors the real lib/tn-account-session.js sequencing: login, identity,
    // then release the marker the login wrote -- and NOT the release when
    // either of the first two threw.
    ensureLoginAndIdentity: async ({ resolved }) => {
      events.push(`login:${resolved.account}`);
      const failure = loginFailures[resolution - 1];
      if (failure) throw failure;
      events.push(`identity:${resolved.account}`);
      const currentIdentityFailure = identityFailures[resolution - 1] || identityFailure;
      if (currentIdentityFailure) throw currentIdentityFailure;
      events.push(`confirm-marker:${resolved.account}`);
    },
    cleanupAndRelease: async ({ profileDir }) => {
      events.push(`cleanup:${profileDir}`);
      if (cleanupConfirmed) return { confirmed: true, safeToClose: true };
      return { confirmed: false, safeToClose: cleanupSafeToClose, error: new Error("cleanup failed") };
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
    "owner-check:blta",
    "launch:/synthetic/profiles/blta/browser-profile",
    "login:blta",
    "identity:blta",
    "confirm-marker:blta",
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
  // The account that actually succeeded must reach identity AND release its
  // marker. blta's failed login correctly releases nothing -- that marker is
  // supposed to survive an unverified login.
  assert.deepEqual(
    lane.events.filter((event) => event.startsWith("confirm-marker:")),
    ["confirm-marker:blt2"],
    JSON.stringify(lane.events),
  );
  assert.equal(lane.events.includes("identity:blt2"), true);
  await opened.release();
});

test("busy is a clean skip and never resolves or launches a second account", async () => {
  const lane = harness({ accounts: ["blta", "blt2"], busy: true });
  const result = await openTnSession({}, lane.deps);
  assert.deepEqual(result, { skip: true, reason: "busy" });
  assert.equal(lane.resolutions(), 1);
  assert.equal(lane.events.some((event) => event.startsWith("launch:")), false);
  assert.equal(lane.events.some((event) => event.startsWith("owner-check:") || event.startsWith("secure:")), false);
});

test("an envelope mismatch re-acquires the same account and quarantines the stale profile once", async () => {
  const mismatch = Object.assign(new Error("synthetic envelope mismatch"), { code: "session_envelope_mismatch" });
  const lane = harness({ accounts: ["blta", "blta"], acquireFailures: [mismatch] });
  const opened = await openTnSession({}, lane.deps);
  assert.equal(opened.account, "blta");
  assert.equal(lane.resolutions(), 2);
  assert.equal(lane.events.includes("quarantine:/synthetic/profiles/blta/browser-profile"), true);
  assert.equal(lane.events.filter((event) => event.startsWith("launch:")).length, 1);
  await opened.release();
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

test("a cleaned Playwright persistent-context timeout re-acquires and retries once", async () => {
  const lane = harness({
    accounts: ["blta", "blta"],
    launchFailures: [new Error("browserType.launchPersistentContext: Timeout 180000ms exceeded."), null],
  });
  const opened = await openTnSession({}, lane.deps);
  assert.equal(opened.account, "blta");
  assert.equal(lane.resolutions(), 2);
  const firstCleanup = lane.events.indexOf("cleanup:/synthetic/profiles/blta/browser-profile");
  const secondResolve = lane.events.lastIndexOf("resolve:blta");
  assert.ok(firstCleanup >= 0 && firstCleanup < secondResolve, JSON.stringify(lane.events));
  assert.equal(lane.events.includes("quarantine:/synthetic/profiles/blta/browser-profile"), true);
  assert.equal(lane.events.filter((event) => event.startsWith("launch:")).length, 2);
  await opened.release();
});

test("a second persistent-context timeout is terminal", async () => {
  const lane = harness({
    accounts: ["blta", "blta"],
    launchFailures: [
      new Error("browserType.launchPersistentContext: Timeout 180000ms exceeded."),
      new Error("browserType.launchPersistentContext: Timeout 180000ms exceeded."),
    ],
  });
  await assert.rejects(() => openTnSession({}, lane.deps), /launchPersistentContext: Timeout/);
  assert.equal(lane.resolutions(), 2);
});

test("cleanup uncertainty blocks a persistent-context retry", async () => {
  const lane = harness({
    launchFailures: [new Error("browserType.launchPersistentContext: Timeout 180000ms exceeded.")],
    cleanupConfirmed: false,
  });
  await assert.rejects(() => openTnSession({}, lane.deps), AggregateError);
  assert.equal(lane.resolutions(), 1);
});

test("isTransientPreWorkTimeout recognizes the diagnosed transient pre-work error shapes and nothing else", () => {
  assert.equal(isTransientPreWorkTimeout(loginStageTimeoutError()), true);
  assert.equal(isTransientPreWorkTimeout(pageGotoTimeoutError()), true);
  assert.equal(isTransientPreWorkTimeout(identityReadError()), true);
  assert.equal(isTransientPreWorkTimeout(new Error("browserType.launchPersistentContext: Timeout 180000ms exceeded.")), false);
  assert.equal(isTransientPreWorkTimeout(new Error("identity mismatch")), false);
  assert.equal(isTransientPreWorkTimeout(preworkError("blta")), false);
  assert.equal(isTransientPreWorkTimeout(undefined), false);
});

test("a broker identity read exception retries once after confirmed teardown", async () => {
  const lane = harness({
    accounts: ["blta", "blta"],
    identityFailures: [identityReadError(), null],
  });
  const opened = await openTnSession({}, lane.deps);
  assert.equal(opened.account, "blta");
  assert.equal(lane.resolutions(), 2);
  const firstCleanup = lane.events.indexOf("cleanup:/synthetic/profiles/blta/browser-profile");
  const secondResolve = lane.events.lastIndexOf("resolve:blta");
  assert.ok(firstCleanup >= 0 && firstCleanup < secondResolve, JSON.stringify(lane.events));
  await opened.release();
});

test("a second broker identity read exception is terminal", async () => {
  const lane = harness({
    accounts: ["blta", "blta"],
    identityFailures: [identityReadError(), identityReadError()],
  });
  await assert.rejects(() => openTnSession({}, lane.deps), /identity_read_error/);
  assert.equal(lane.resolutions(), 2);
});

test("a transient login-stage timeout retries once on the same account and succeeds", async () => {
  const lane = harness({
    accounts: ["blta", "blta"],
    loginFailures: [loginStageTimeoutError(), null],
  });
  const opened = await openTnSession({}, lane.deps);
  assert.equal(opened.account, "blta");
  assert.equal(lane.resolutions(), 2);
  const firstCleanup = lane.events.indexOf("cleanup:/synthetic/profiles/blta/browser-profile");
  const secondResolve = lane.events.lastIndexOf("resolve:blta");
  assert.ok(firstCleanup >= 0 && firstCleanup < secondResolve, JSON.stringify(lane.events));
  assert.equal(lane.events.filter((event) => event.startsWith("login:")).length, 2);
  await opened.release();
});

test("a transient page.goto timeout retries once on the same account and succeeds", async () => {
  const lane = harness({
    accounts: ["blta", "blta"],
    loginFailures: [pageGotoTimeoutError(), null],
  });
  const opened = await openTnSession({}, lane.deps);
  assert.equal(opened.account, "blta");
  assert.equal(lane.resolutions(), 2);
  await opened.release();
});

test("a second transient login timeout is terminal -- no third attempt", async () => {
  const lane = harness({
    accounts: ["blta", "blta"],
    loginFailures: [loginStageTimeoutError(), loginStageTimeoutError()],
  });
  await assert.rejects(() => openTnSession({}, lane.deps), /login timed out/);
  assert.equal(lane.resolutions(), 2);
  assert.equal(lane.events.filter((event) => event.startsWith("login:")).length, 2);
});

test("a cosmetic cleanup failure (browser confirmed dead, lock released) still allows a transient-timeout retry", async () => {
  // Reproduces the actual 2026-09-26 production shape: cleanupAndRelease
  // returns confirmed:false only because the polite context/browser close
  // timed out, while safeToClose is true because the broker's kill-and-
  // confirm already proved the browser dead and the lock released. Before
  // this fix, that made openTnSession throw the "pre-work failure and
  // cleanup both failed" AggregateError and skip the retry entirely.
  const lane = harness({
    accounts: ["blta", "blta"],
    loginFailures: [loginStageTimeoutError(), null],
    cleanupConfirmed: false,
    cleanupSafeToClose: true,
  });
  const opened = await openTnSession({}, lane.deps);
  assert.equal(opened.account, "blta");
  assert.equal(lane.resolutions(), 2);
  await opened.release();
});

test("an unsafe cleanup failure still blocks a transient-timeout retry", async () => {
  const lane = harness({
    loginFailures: [loginStageTimeoutError()],
    cleanupConfirmed: false,
    cleanupSafeToClose: false,
  });
  await assert.rejects(() => openTnSession({}, lane.deps), AggregateError);
  assert.equal(lane.resolutions(), 1);
});

test("a non-transient login failure never retries", async () => {
  const lane = harness({
    accounts: ["blta", "blt2"],
    loginFailures: [new Error("some other login failure")],
  });
  await assert.rejects(() => openTnSession({}, lane.deps), /some other login failure/);
  assert.equal(lane.resolutions(), 1);
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
