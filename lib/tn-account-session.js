// tn-account-session.js — orchestrates this job's use of pay-period-tracker's
// TN multi-account broker (spec: TN-ACCOUNT-SPEC-V4-2026-07-28.md). Entirely
// dark behind TN_ACCOUNT_SYSTEM=1; index.js only calls into this module when
// the flag is on. Every broker call goes through the facade in
// account-broker.js's loadBroker() — this file reimplements NONE of the
// lock/resolve/login-safety/identity DOM logic itself.
//
// This job (com.blt.intake-doc-reminders) pins account "blta" and always
// uses the "skip-if-busy" lock class (coordinator's ruling: a missed hourly
// pass is fine, never queue-pile waiting for the account).

const path = require('path');
const os = require('os');

const JOB_NAME = 'com.blt.intake-doc-reminders';
const REGISTRY_PATH = path.join(__dirname, '..', 'config', 'tn-account-registry.json');
const LOCK_CLASS = 'skip-if-busy';

function isEnabled(env = process.env) {
  return String(env.TN_ACCOUNT_SYSTEM || '').trim() === '1';
}

/**
 * Resolve the account for this run (registry-checked, credential-resolved)
 * via the broker's resolveAccountForRun. Throws (fail closed) on any
 * mismatch or unusable-with-no-fallback account — before any browser
 * action.
 */
async function resolveAccount({ env = process.env, broker, machine } = {}) {
  const dopplerReader = broker.doppler.createDopplerReader(env);
  const decision = await broker.resolveAccountForRun({
    env,
    jobName: JOB_NAME,
    registryPath: REGISTRY_PATH,
    dopplerReader,
    machine: machine || env.TN_ACCOUNT_MACHINE || os.hostname(),
  });
  return { decision, dopplerReader };
}

/**
 * Acquire the per-account lock around the whole browser session (skip-if-
 * busy: caller must treat ok:false as a clean skip, never an error).
 */
async function acquireSession({ account, broker, env = process.env, browserProfileDir = null, sendNotification } = {}) {
  return broker.acquireAccountSession(account, {
    jobName: JOB_NAME,
    lockClass: LOCK_CLASS,
    env,
    browserProfileDir,
    sendNotification,
  });
}

/**
 * Wrap a TN DOM login (tn.js's login()) in the broker's login-safety
 * protocol: cooldown check, intent-marker check, write intent marker
 * BEFORE submit, classify the outcome via the broker's own
 * classifyLoginOutcome, apply it (arms/clears cooldown + intent per spec).
 * `doLogin(page, resolved, { onSubmit })` must call onSubmit() at the
 * moment the password is actually submitted, so pre-submit failures never
 * arm a cooldown.
 */
async function loginWithBroker({ page, broker, resolved, env = process.env, dopplerReader, dopplerWriter, doLogin, now = new Date() }) {
  const account = resolved.account;
  const markerDeps = { env, dopplerReader };
  const cooldown = await broker.markers.cooldownActive(account, markerDeps);
  if (cooldown) {
    throw new Error(`TN account "${account}" is in an active login cooldown; refusing a password login until a human clears it.`);
  }
  const intentPresent = await broker.markers.intentMarkerPresent(account, markerDeps);
  if (intentPresent) {
    throw new Error(`TN account "${account}" has a consumed-attempt intent marker still set; refusing another password login until a human clears it.`);
  }

  const writer = dopplerWriter || broker.doppler.createDopplerWriter(env);
  const writeDeps = { env, dopplerReader, dopplerWriter: writer };

  // Attempt reservation BEFORE submit (spec "Login safety"): a crash after
  // this point leaves evidence — the next run treats it as a consumed
  // failed attempt until a human clears it.
  await broker.markers.writeIntentMarker(account, { jobName: JOB_NAME, pid: process.pid, now, ...writeDeps });

  let submitted = false;
  let loginError = null;
  try {
    await doLogin(page, resolved, { onSubmit: () => { submitted = true; } });
  } catch (e) {
    loginError = e;
  }

  // tn.js's login() throws a distinct "TN login rejected" message on a
  // confirmed credential rejection; any other post-submit failure (timeout,
  // unclassified page state) is conservatively "ambiguous" per spec 5c,
  // which still arms the cooldown — never silently trusted as safe-to-retry.
  const confirmedRejection = Boolean(loginError && /rejected/i.test(loginError.message || ''));
  const outcome = broker.loginSafety.classifyLoginOutcome({
    submitted,
    confirmedSuccess: !loginError,
    confirmedRejection,
  });
  await broker.markers.applyLoginOutcome(account, outcome, { jobName: JOB_NAME, now, ...writeDeps });

  if (loginError) throw loginError;
}

/** Read the logged-in username and assert it matches the resolved account. Throws on mismatch. */
async function assertIdentityOrThrow({ page, broker, resolved }) {
  const observedUsername = await broker.readLoggedInUsername(page, {});
  const identity = broker.identityGate.assertIdentity({ observedUsername, expectedUsername: resolved.username });
  if (!identity.ok) {
    throw new Error(`TN identity assertion failed for account "${resolved.account}": ${identity.reason} (observed="${identity.observed || ''}")`);
  }
  return identity;
}

module.exports = {
  JOB_NAME,
  REGISTRY_PATH,
  LOCK_CLASS,
  isEnabled,
  resolveAccount,
  acquireSession,
  loginWithBroker,
  assertIdentityOrThrow,
};
