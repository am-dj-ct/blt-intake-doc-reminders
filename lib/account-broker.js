// account-broker.js — seam onto pay-period-tracker's TN multi-account broker
// (spec: TN-ACCOUNT-SPEC-V4-2026-07-28.md). Entirely dark behind
// TN_ACCOUNT_SYSTEM=1 (checked by the caller before anything here runs).
//
// One Writer Per Artifact: pay-period-tracker owns every tn-account-*.js
// module. This repo NEVER vendors a copy — it requires the broker's own
// checkout at runtime via PAY_PERIOD_TRACKER_ROOT (default ~/pay-period-tracker).
// If that root or the modules under it are missing/unrequireable while the
// flag is on, this fails closed with a clear error naming what's missing —
// it never silently falls back to legacy single-account behavior.

const path = require('path');
const os = require('os');

function resolveBrokerRoot(env = process.env) {
  const override = String(env.PAY_PERIOD_TRACKER_ROOT || '').trim();
  return override || path.join(os.homedir(), 'pay-period-tracker');
}

// Injectable `requireFn` so tests can substitute a fake broker without a
// real pay-period-tracker checkout on disk. Defaults to Node's own require.
function loadBroker(env = process.env, requireFn = require) {
  const root = resolveBrokerRoot(env);
  const brokerPath = path.join(root, 'src', 'therapynotes', 'tn-account-broker.js');
  const scheduleBrowserPath = path.join(root, 'src', 'therapynotes', 'schedule-browser.js');

  let broker;
  try {
    broker = requireFn(brokerPath);
  } catch (e) {
    throw new Error(
      `TN_ACCOUNT_SYSTEM=1 but the TN account broker could not be loaded from ${brokerPath} ` +
      `(PAY_PERIOD_TRACKER_ROOT=${root}). Refusing to fall back to legacy TN login. Underlying error: ${e.message}`
    );
  }
  if (!broker || typeof broker.resolveAccountForRun !== 'function' || typeof broker.acquireAccountSession !== 'function') {
    throw new Error(
      `TN_ACCOUNT_SYSTEM=1 but ${brokerPath} did not export the expected broker API ` +
      `(resolveAccountForRun/acquireAccountSession). Refusing to fall back to legacy TN login.`
    );
  }

  let scheduleBrowser;
  try {
    scheduleBrowser = requireFn(scheduleBrowserPath);
  } catch (e) {
    throw new Error(
      `TN_ACCOUNT_SYSTEM=1 but ${scheduleBrowserPath} could not be loaded (PAY_PERIOD_TRACKER_ROOT=${root}). ` +
      `Refusing to fall back to legacy TN login. Underlying error: ${e.message}`
    );
  }
  if (typeof scheduleBrowser.readLoggedInUsername !== 'function') {
    throw new Error(
      `TN_ACCOUNT_SYSTEM=1 but ${scheduleBrowserPath} does not export readLoggedInUsername. ` +
      `Refusing to fall back to legacy TN login.`
    );
  }

  if (!broker.identityGate || typeof broker.identityGate.assertIdentity !== 'function') {
    throw new Error(
      `TN_ACCOUNT_SYSTEM=1 but the broker's identityGate.assertIdentity was not found at ${brokerPath}. ` +
      `Refusing to fall back to legacy TN login.`
    );
  }
  if (!broker.registry || typeof broker.registry.assertRegistryMatch !== 'function') {
    throw new Error(
      `TN_ACCOUNT_SYSTEM=1 but the broker's registry.assertRegistryMatch was not found at ${brokerPath}. ` +
      `Refusing to fall back to legacy TN login.`
    );
  }
  if (!broker.markers || !broker.doppler) {
    throw new Error(
      `TN_ACCOUNT_SYSTEM=1 but the broker's markers/doppler modules were not found at ${brokerPath}. ` +
      `Refusing to fall back to legacy TN login.`
    );
  }

  return { ...broker, readLoggedInUsername: scheduleBrowser.readLoggedInUsername };
}

module.exports = { resolveBrokerRoot, loadBroker };
