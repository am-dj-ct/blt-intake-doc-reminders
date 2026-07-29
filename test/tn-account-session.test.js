const { test } = require('node:test');
const assert = require('node:assert/strict');
const session = require('../lib/tn-account-session');

function fakeBroker(overrides = {}) {
  return {
    doppler: { createDopplerReader: () => async () => '', createDopplerWriter: () => async () => {} },
    markers: {
      cooldownActive: async () => false,
      intentMarkerPresent: async () => false,
      writeIntentMarker: async () => {},
      applyLoginOutcome: async () => {},
      ...overrides.markers,
    },
    loginSafety: {
      // Mirrors the real classifyLoginOutcome semantics closely enough for
      // this seam's own tests (production semantics live in and are tested
      // by pay-period-tracker; we only verify OUR call shape here).
      classifyLoginOutcome: ({ submitted, confirmedSuccess, confirmedRejection }) => {
        if (!submitted) return 'pre_submit_failure';
        if (confirmedSuccess && confirmedRejection) return 'post_submit_ambiguous';
        if (confirmedSuccess) return 'confirmed_success';
        if (confirmedRejection) return 'confirmed_rejection';
        return 'post_submit_ambiguous';
      },
      ...overrides.loginSafety,
    },
    identityGate: {
      assertIdentity: ({ observedUsername, expectedUsername }) => {
        if (!observedUsername) return { ok: false, reason: 'identity_unreadable' };
        if (observedUsername.toLowerCase() !== expectedUsername.toLowerCase()) {
          return { ok: false, reason: 'identity_mismatch', observed: observedUsername, expected: expectedUsername };
        }
        return { ok: true };
      },
      ...overrides.identityGate,
    },
    readLoggedInUsername: overrides.readLoggedInUsername || (async () => 'blta'),
    resolveAccountForRun: overrides.resolveAccountForRun,
    acquireAccountSession: overrides.acquireAccountSession,
  };
}

test('resolveAccount: TN_ACCOUNT unset -> broker rejects, no browser touched', async () => {
  let called = false;
  const broker = fakeBroker({
    resolveAccountForRun: async () => {
      called = true;
      throw new Error('TN_ACCOUNT is required when TN_ACCOUNT_SYSTEM is on.');
    },
  });
  await assert.rejects(
    () => session.resolveAccount({ env: {}, broker }),
    /TN_ACCOUNT is required/,
  );
  assert.equal(called, true);
});

test('resolveAccount: registry mismatch propagates and fails closed', async () => {
  const broker = fakeBroker({
    resolveAccountForRun: async () => {
      throw new Error('TN account registry mismatch for job "com.blt.intake-doc-reminders": registry says "blta", wrapper is using "blt2".');
    },
  });
  await assert.rejects(
    () => session.resolveAccount({ env: { TN_ACCOUNT: 'blt2' }, broker }),
    /registry mismatch/,
  );
});

test('resolveAccount passes this job\'s name and local registry path to the broker', async () => {
  let seen = null;
  const broker = fakeBroker({
    resolveAccountForRun: async (args) => { seen = args; return { resolved: { account: 'blta', username: 'blta' }, lockClass: 'skip-if-busy' }; },
  });
  await session.resolveAccount({ env: { TN_ACCOUNT: 'blta' }, broker, machine: 'Alexs-Mac-mini.local' });
  assert.equal(seen.jobName, session.JOB_NAME);
  assert.equal(seen.registryPath, session.REGISTRY_PATH);
  assert.equal(seen.machine, 'Alexs-Mac-mini.local');
});

test('acquireSession: skip-if-busy busy -> ok:false, caller must skip cleanly (no throw)', async () => {
  const broker = fakeBroker({
    acquireAccountSession: async (account, opts) => {
      assert.equal(account, 'blta');
      assert.equal(opts.lockClass, 'skip-if-busy');
      return { ok: false, reason: 'busy' };
    },
  });
  const result = await session.acquireSession({ account: 'blta', broker, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'busy');
});

test('loginWithBroker: cooldown active -> refuses without writing a new intent marker', async () => {
  let intentWritten = false;
  const broker = fakeBroker({
    markers: {
      cooldownActive: async () => true,
      intentMarkerPresent: async () => false,
      writeIntentMarker: async () => { intentWritten = true; },
      applyLoginOutcome: async () => {},
    },
  });
  await assert.rejects(
    () => session.loginWithBroker({ page: {}, broker, resolved: { account: 'blta', username: 'blta' }, env: {}, doLogin: async () => {} }),
    /active login cooldown/,
  );
  assert.equal(intentWritten, false);
});

test('loginWithBroker: successful login writes then clears intent, classifies confirmed_success', async () => {
  const outcomes = [];
  const broker = fakeBroker({
    markers: {
      cooldownActive: async () => false,
      intentMarkerPresent: async () => false,
      writeIntentMarker: async () => {},
      applyLoginOutcome: async (account, outcome) => { outcomes.push(outcome); },
    },
  });
  let onSubmitCalled = false;
  await session.loginWithBroker({
    page: {}, broker, resolved: { account: 'blta', username: 'blta' }, env: {},
    doLogin: async (page, creds, { onSubmit }) => { onSubmit(); onSubmitCalled = true; },
  });
  assert.equal(onSubmitCalled, true);
  assert.deepEqual(outcomes, ['confirmed_success']);
});

test('loginWithBroker: pre-submit throw classifies pre_submit_failure (no cooldown)', async () => {
  const outcomes = [];
  const broker = fakeBroker({
    markers: {
      cooldownActive: async () => false,
      intentMarkerPresent: async () => false,
      writeIntentMarker: async () => {},
      applyLoginOutcome: async (account, outcome) => { outcomes.push(outcome); },
    },
  });
  await assert.rejects(
    () => session.loginWithBroker({
      page: {}, broker, resolved: { account: 'blta', username: 'blta' }, env: {},
      doLogin: async () => { throw new Error('TN login did not complete (still on /login/ after 30s).'); },
    }),
  );
  assert.deepEqual(outcomes, ['pre_submit_failure']);
});

test('loginWithBroker: confirmed rejection after submit arms cooldown classification', async () => {
  const outcomes = [];
  const broker = fakeBroker({
    markers: {
      cooldownActive: async () => false,
      intentMarkerPresent: async () => false,
      writeIntentMarker: async () => {},
      applyLoginOutcome: async (account, outcome) => { outcomes.push(outcome); },
    },
  });
  await assert.rejects(
    () => session.loginWithBroker({
      page: {}, broker, resolved: { account: 'blta', username: 'blta' }, env: {},
      doLogin: async (page, creds, { onSubmit }) => { onSubmit(); throw new Error('TN login rejected — check credentials in Doppler.'); },
    }),
  );
  assert.deepEqual(outcomes, ['confirmed_rejection']);
});

test('assertIdentityOrThrow: mismatch throws before any read', async () => {
  const broker = fakeBroker({ readLoggedInUsername: async () => 'blt2' });
  await assert.rejects(
    () => session.assertIdentityOrThrow({ page: {}, broker, resolved: { account: 'blta', username: 'blta' } }),
    /identity assertion failed/,
  );
});

test('assertIdentityOrThrow: match resolves', async () => {
  const broker = fakeBroker({ readLoggedInUsername: async () => 'blta' });
  const result = await session.assertIdentityOrThrow({ page: {}, broker, resolved: { account: 'blta', username: 'blta' } });
  assert.equal(result.ok, true);
});
