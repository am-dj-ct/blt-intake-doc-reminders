"use strict";

// The only TherapyNotes account/session seam for this repo. pay-period-
// tracker owns account selection, login attempt markers, identity checks,
// per-account locks, and the bounded pre-work failover decision.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TN_SCHEDULING_URL } = require("../config");

const JOB_NAME = "com.blt.intake-doc-reminders";
const REGISTRY_PATH = path.join(__dirname, "..", "config", "tn-account-registry.json");
const ACCOUNT_PROFILE = "standard";
const LOCK_CLASS = "skip-if-busy";
const NORMAL_ACCOUNTS = Object.freeze(["blta", "blt2"]);
const TRANSIENT_PROFILE_SYMLINKS = Object.freeze([
  "RunningChromeVersion",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);
const PROFILE_BASE = path.join(os.homedir(), ".blt-automation", "therapynotes", "accounts");
const CLEANUP_TIMEOUT_MS = 10_000;

function isEnabled(env = process.env) {
  if (String(env.TN_ACCOUNT_SYSTEM ?? "").trim() === "0") {
    throw new Error("Unbrokered TherapyNotes mode is retired.");
  }
  return true;
}

function assertStandardDecision(decision, env = process.env) {
  const requested = String(env.TN_ACCOUNT || "").trim().toLowerCase();
  const decided = String(decision?.account || "").trim().toLowerCase();
  const selected = String(decision?.resolved?.account || "").trim().toLowerCase();
  const substituted = selected !== requested;
  if (!NORMAL_ACCOUNTS.includes(requested) || !NORMAL_ACCOUNTS.includes(selected) || decided !== selected ||
      Boolean(decision?.usedFallback) !== substituted || decision?.lockClass !== LOCK_CLASS) {
    throw new Error("Intake reminders received an invalid standard TherapyNotes broker route.");
  }
  return selected;
}

async function resolveAccount({ env = process.env, broker, machine } = {}) {
  const dopplerReader = broker.doppler.createDopplerReader(env);
  const decision = await broker.resolveAccountForRun({
    env,
    jobName: JOB_NAME,
    accountProfile: ACCOUNT_PROFILE,
    registryPath: REGISTRY_PATH,
    dopplerReader,
    machine: machine || os.hostname(),
  });
  assertStandardDecision(decision, env);
  return { decision, dopplerReader };
}

function profileDirFor(account, base = PROFILE_BASE) {
  if (!NORMAL_ACCOUNTS.includes(account)) throw new Error("Intake reminders refused a non-standard TherapyNotes profile.");
  return path.join(base, account, "browser-profile");
}

function securePathTree(profileDir, { lockOwnershipVerified = false } = {}) {
  if (!lockOwnershipVerified) {
    throw new Error("TherapyNotes profile cleanup requires verified account-lock ownership.");
  }
  if (!profileDir || !path.isAbsolute(profileDir) || path.resolve(profileDir) !== profileDir) {
    throw new Error("TherapyNotes profile path must be normalized and absolute.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let cursor = profileDir;
  let trusted = uid === null ? path.parse(profileDir).root : null;
  while (true) {
    let stat = null;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat?.isSymbolicLink()) throw new Error("TherapyNotes profile ancestry contains a symlink.");
    if (stat && !stat.isDirectory()) throw new Error("TherapyNotes profile ancestry contains a non-directory.");
    if (stat && uid !== null && stat.uid === uid) {
      if ((stat.mode & 0o022) !== 0) throw new Error("TherapyNotes profile ancestry is group- or world-writable.");
      trusted = cursor;
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!trusted) throw new Error("TherapyNotes profile path has no trusted user-owned ancestor.");
  let current = trusted;
  for (const component of path.relative(trusted, profileDir).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat = null;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!stat) {
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
      throw new Error("TherapyNotes profile path is not private and owner-controlled.");
    }
    fs.chmodSync(current, 0o700);
  }
  const visit = (target) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      const directTransient = path.dirname(target) === profileDir && TRANSIENT_PROFILE_SYMLINKS.includes(path.basename(target));
      if (!directTransient) throw new Error("TherapyNotes profile tree contains an unapproved symlink.");
      fs.unlinkSync(target);
      return;
    }
    if (uid !== null && stat.uid !== uid) throw new Error("TherapyNotes profile tree is not owner-controlled.");
    if (stat.isDirectory()) {
      fs.chmodSync(target, 0o700);
      for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
    } else if (stat.isFile()) fs.chmodSync(target, 0o600);
    else throw new Error("TherapyNotes profile tree contains an unsupported entry.");
  };
  visit(path.dirname(profileDir));
}

async function acquireSession({ account, broker, env = process.env, browserProfileDir, sendNotification } = {}) {
  return broker.acquireAccountSession(account, {
    jobName: JOB_NAME,
    lockClass: LOCK_CLASS,
    env,
    browserProfileDir,
    sendNotification,
  });
}

async function ensureLogin({ page, broker, resolved, env = process.env, dopplerReader, now = new Date() }) {
  await page.goto(TN_SCHEDULING_URL, { waitUntil: "domcontentloaded" });
  if (!(await broker.therapyNotesLoginVisible(page))) return { freshLogin: false };
  const loginUrl = `https://www.therapynotes.com/app/login/${encodeURIComponent(resolved.practiceCode)}/`;
  await broker.performAccountBrokerLogin(page, {
    loginUrl,
    scheduleUrl: TN_SCHEDULING_URL,
    username: resolved.username,
    password: resolved.password,
    practiceCode: resolved.practiceCode,
    allowPasswordLogin: true,
    timeoutMs: 30_000,
    settleMs: 1_000,
  }, TN_SCHEDULING_URL, {
    account: resolved.account,
    jobName: JOB_NAME,
    env,
    dopplerReader,
    dopplerWriter: broker.doppler.createDopplerWriter(env),
    now,
    isSuccessUrl: (value) => broker.isTherapyNotesAppUrlFamily(value, "/app/scheduling/"),
  });
  return { freshLogin: true };
}

/**
 * Release the intent marker this run's login wrote.
 *
 * The broker writes an intent marker BEFORE submitting a password and
 * deliberately does not clear it on success -- the caller must confirm, and
 * only after its own identity check passes. That design is correct (a login
 * whose identity could not be verified must keep looking "consumed" to the
 * next job), but this repo never made the confirming call: every hourly run
 * left a `blta` marker behind for the next resolution attempt to reclaim as
 * a dead pid. Around ninety such archived markers accumulated between
 * 2026-08-07 and 2026-08-16, all `auto-cleared-dead-pid`, all this job.
 *
 * Note this is NOT an exit trap, and must not become one. A marker surviving
 * a FAILED or ambiguous login is the safety property; only a login this run
 * made and then verified may be released.
 */
async function confirmLoginUsable({ broker, resolved, env = process.env, dopplerReader, now = new Date() }) {
  await broker.confirmAccountBrokerLoginUsable(resolved.account, {
    jobName: JOB_NAME,
    now,
    env,
    dopplerReader,
    dopplerWriter: broker.doppler.createDopplerWriter(env),
  });
}

/**
 * Log in, verify the identity, and release the marker -- in that order, as
 * one call.
 *
 * Deliberately one function rather than three the caller sequences: the
 * defect this fixes was exactly a caller that ran the first two steps and
 * silently skipped the third. pay-period-tracker consolidated its own five
 * call sites into a shared helper after the same class of mistake.
 */
async function ensureLoginAndIdentity({ page, broker, resolved, env = process.env, dopplerReader, now = new Date() }) {
  const { freshLogin } = await ensureLogin({ page, broker, resolved, env, dopplerReader, now });
  const identity = await assertIdentityOrThrow({ page, broker, resolved });
  // Only a login THIS run performed leaves a marker to release. A reused
  // stored session never wrote one, and confirming one it does not own could
  // clear a marker another job is relying on.
  if (freshLogin) await confirmLoginUsable({ broker, resolved, env, dopplerReader, now });
  return { freshLogin, identity };
}

async function assertIdentityOrThrow({ page, broker, resolved }) {
  const observedUsername = await broker.readLoggedInUsername(page, {});
  const identity = broker.identityGate.assertIdentity({ observedUsername, expectedUsername: resolved.username });
  if (!identity.ok) throw new Error(`TN identity assertion failed for account "${resolved.account}": ${identity.reason}`);
  return identity;
}

async function bounded(promise, label, timeoutMs = CLEANUP_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cleanupAndRelease({ launched, profileDir, lockSession, broker, timeoutMs = CLEANUP_TIMEOUT_MS }) {
  // Two buckets. `soft` = best-effort graceful-close failures (context/browser
  // .close() timing out or throwing). The browser is torn down authoritatively
  // by killProfileDirAndConfirm below no matter what, so a soft failure means
  // the polite close was slow, NOT that a session leaked. `hard` = failures
  // that mean we cannot prove a safe teardown/release (death unconfirmed, lock
  // ownership unproven, profile not secured, lock not released).
  //
  // `confirmed` stays strict: ANY error, soft or hard, makes it false, so
  // same-run account failover is never authorized on an imperfect teardown.
  // `safeToClose` is the weaker signal the normal (non-failover) caller uses:
  // the browser really died and the lock really released, so the run must not
  // crash just because the graceful close timed out.
  const soft = [];
  const hard = [];
  const context = launched?.context;
  const browser = launched?.browser;
  try { if (context?.close) await bounded(context.close(), "TherapyNotes context cleanup", timeoutMs); }
  catch (error) { soft.push(error); }
  try { if (browser?.isConnected?.()) await bounded(browser.close(), "TherapyNotes browser cleanup", timeoutMs); }
  catch (error) { soft.push(error); }

  let death;
  try { death = await broker.lock.killProfileDirAndConfirm(profileDir, undefined, { maxWaitMs: timeoutMs }); }
  catch (error) { hard.push(error); }
  const deathConfirmed = browser?.isConnected?.() !== true && death?.confirmed === true && (death.stillAlive?.length || 0) === 0;
  if (!deathConfirmed) {
    hard.push(new Error("TherapyNotes browser death was not confirmed; account lock remains held."));
    return { confirmed: false, safeToClose: false, deathConfirmed: false, released: false,
      error: new AggregateError([...hard, ...soft], "TherapyNotes cleanup was not confirmed.") };
  }

  let ownerCheck;
  try { ownerCheck = lockSession.verifyStillOwner(); }
  catch (error) { hard.push(error); }
  if (!ownerCheck?.ok) {
    hard.push(new Error(`TherapyNotes account lock ownership was not proven before profile cleanup (${ownerCheck?.reason || "verification_failed"}).`));
  } else {
    try { securePathTree(profileDir, { lockOwnershipVerified: true }); } catch (error) { hard.push(error); }
  }
  let released = false;
  try {
    const releaseResult = await lockSession.release();
    if (releaseResult?.ok) released = true;
    else hard.push(new Error(`TherapyNotes account lock release was not confirmed (${releaseResult?.reason || "unknown"}).`));
  } catch (error) { hard.push(error); }

  const safeToClose = deathConfirmed && released && hard.length === 0;
  if (hard.length || soft.length) {
    return { confirmed: false, safeToClose, deathConfirmed, released,
      error: new AggregateError([...hard, ...soft], "TherapyNotes cleanup completed with errors.") };
  }
  return { confirmed: true, safeToClose: true, deathConfirmed: true, released: true };
}

function retryableFreshLoginRejection(error) {
  return error?.code === "tn_account_prework_unavailable" && error?.loginOutcome === "confirmed_rejection";
}

module.exports = {
  JOB_NAME,
  REGISTRY_PATH,
  ACCOUNT_PROFILE,
  LOCK_CLASS,
  NORMAL_ACCOUNTS,
  TRANSIENT_PROFILE_SYMLINKS,
  CLEANUP_TIMEOUT_MS,
  isEnabled,
  assertStandardDecision,
  resolveAccount,
  profileDirFor,
  securePathTree,
  acquireSession,
  ensureLogin,
  ensureLoginAndIdentity,
  confirmLoginUsable,
  assertIdentityOrThrow,
  cleanupAndRelease,
  retryableFreshLoginRejection,
};
