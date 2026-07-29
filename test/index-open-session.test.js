// Covers the 4 required regression scenarios for the TN account broker
// wiring (see coordinator brief), through index.js's openTnSession() seam,
// with the broker/tn modules fully mocked — no real network, no real
// Doppler, no real TN, no real pay-period-tracker checkout required.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openTnSession } = require('../index');

function fakeTn({ loginImpl } = {}) {
  const calls = { launch: 0, login: 0, closed: 0 };
  return {
    calls,
    launch: async () => { calls.launch++; return { browser: { close: async () => { calls.closed++; } }, page: {} }; },
    login: loginImpl || (async (page, creds, opts) => {
      calls.login++;
      if (opts && typeof opts.onSubmit === 'function') opts.onSubmit();
    }),
  };
}

test('1. flag on, TN_ACCOUNT unset -> fails closed before any browser action', async () => {
  const tnLib = fakeTn();
  const broker = {
    resolveAccountForRun: async () => { throw new Error('TN_ACCOUNT is required when TN_ACCOUNT_SYSTEM is on.'); },
  };
  const tnAccountSession = {
    isEnabled: () => true,
    resolveAccount: async ({ broker: b }) => { await b.resolveAccountForRun(); },
  };
  await assert.rejects(
    () => openTnSession({}, { env: { TN_ACCOUNT_SYSTEM: '1' }, tn: tnLib, broker, tnAccountSession }),
    /TN_ACCOUNT is required/,
  );
  assert.equal(tnLib.calls.launch, 0, 'browser must never launch when account resolution fails closed');
  assert.equal(tnLib.calls.login, 0);
});

test('2. registry mismatch (wrong account/machine) -> fails closed before any browser action', async () => {
  const tnLib = fakeTn();
  const broker = {
    resolveAccountForRun: async () => {
      throw new Error('TN account registry mismatch for job "com.blt.intake-doc-reminders": registry says "blta", this machine is "some-other-host".');
    },
  };
  const tnAccountSession = {
    isEnabled: () => true,
    resolveAccount: async ({ broker: b }) => { await b.resolveAccountForRun(); },
  };
  await assert.rejects(
    () => openTnSession({}, { env: { TN_ACCOUNT_SYSTEM: '1', TN_ACCOUNT: 'blta' }, tn: tnLib, broker, tnAccountSession }),
    /registry mismatch/,
  );
  assert.equal(tnLib.calls.launch, 0);
});

test('3. lock skip-if-busy -> run skips cleanly, no error, no browser launched', async () => {
  const tnLib = fakeTn();
  const broker = {};
  const tnAccountSession = {
    isEnabled: () => true,
    resolveAccount: async () => ({ decision: { resolved: { account: 'blta', username: 'blta' } }, dopplerReader: async () => '' }),
    acquireSession: async () => ({ ok: false, reason: 'busy' }),
  };
  const result = await openTnSession({}, { env: { TN_ACCOUNT_SYSTEM: '1', TN_ACCOUNT: 'blta' }, tn: tnLib, broker, tnAccountSession });
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'busy');
  assert.equal(tnLib.calls.launch, 0, 'a busy skip-if-busy lock must never launch a browser');
});

test('4. flag off -> legacy env-fallback login path runs exactly as before (no broker touched)', async () => {
  const tnLib = fakeTn();
  let brokerTouched = false;
  const broker = new Proxy({}, { get() { brokerTouched = true; return () => {}; } });
  const tnAccountSession = {
    isEnabled: (env) => { brokerTouched = brokerTouched || false; return String(env.TN_ACCOUNT_SYSTEM || '') === '1'; },
    resolveAccount: async () => { brokerTouched = true; },
    acquireSession: async () => { brokerTouched = true; return { ok: false }; },
  };
  const result = await openTnSession({}, { env: {}, tn: tnLib, broker, tnAccountSession });
  assert.equal(result.skip, false);
  assert.equal(tnLib.calls.launch, 1);
  assert.equal(tnLib.calls.login, 1, 'legacy tn.login(page) must still be called with no broker wrapping');
  assert.equal(brokerTouched, false, 'the broker must never be touched when TN_ACCOUNT_SYSTEM is off');
  await result.release();
  assert.equal(tnLib.calls.closed, 1);
});

test('4b. flag off with TN_ACCOUNT_SYSTEM=0 also stays on the legacy path', async () => {
  const tnLib = fakeTn();
  const tnAccountSession = { isEnabled: (env) => String(env.TN_ACCOUNT_SYSTEM || '') === '1' };
  const result = await openTnSession({}, { env: { TN_ACCOUNT_SYSTEM: '0' }, tn: tnLib, tnAccountSession });
  assert.equal(result.skip, false);
  assert.equal(tnLib.calls.login, 1);
});

test('flag on, successful resolve+lock+login+identity -> session opened, release closes browser and lock', async () => {
  const tnLib = fakeTn();
  let lockReleased = false;
  const broker = {};
  const tnAccountSession = {
    isEnabled: () => true,
    resolveAccount: async () => ({ decision: { resolved: { account: 'blta', username: 'blta' } }, dopplerReader: async () => '' }),
    acquireSession: async () => ({
      ok: true,
      verifyStillOwner: () => ({ ok: true }),
      release: async () => { lockReleased = true; },
    }),
    loginWithBroker: async ({ doLogin }) => { await doLogin({}, { username: 'blta' }, { onSubmit: () => {} }); },
    assertIdentityOrThrow: async () => ({ ok: true }),
  };
  const result = await openTnSession({}, { env: { TN_ACCOUNT_SYSTEM: '1', TN_ACCOUNT: 'blta' }, tn: tnLib, broker, tnAccountSession });
  assert.equal(result.skip, false);
  assert.equal(tnLib.calls.launch, 1);
  await result.release();
  assert.equal(tnLib.calls.closed, 1);
  assert.equal(lockReleased, true);
});

test('flag on, identity mismatch -> throws and still releases browser + lock', async () => {
  const tnLib = fakeTn();
  let lockReleased = false;
  const tnAccountSession = {
    isEnabled: () => true,
    resolveAccount: async () => ({ decision: { resolved: { account: 'blta', username: 'blta' } }, dopplerReader: async () => '' }),
    acquireSession: async () => ({
      ok: true,
      verifyStillOwner: () => ({ ok: true }),
      release: async () => { lockReleased = true; },
    }),
    loginWithBroker: async () => {},
    assertIdentityOrThrow: async () => { throw new Error('TN identity assertion failed for account "blta": identity_mismatch'); },
  };
  await assert.rejects(
    () => openTnSession({}, { env: { TN_ACCOUNT_SYSTEM: '1', TN_ACCOUNT: 'blta' }, tn: tnLib, tnAccountSession }),
    /identity assertion failed/,
  );
  assert.equal(tnLib.calls.closed, 1, 'browser must be closed even when identity assertion fails');
  assert.equal(lockReleased, true, 'lock must be released even when identity assertion fails');
});
