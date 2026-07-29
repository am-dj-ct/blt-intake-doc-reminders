const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBroker, resolveBrokerRoot } = require('../lib/account-broker');

test('resolveBrokerRoot defaults to ~/pay-period-tracker', () => {
  const root = resolveBrokerRoot({});
  assert.match(root, /pay-period-tracker$/);
});

test('resolveBrokerRoot honors PAY_PERIOD_TRACKER_ROOT override', () => {
  const root = resolveBrokerRoot({ PAY_PERIOD_TRACKER_ROOT: '/custom/ppt' });
  assert.equal(root, '/custom/ppt');
});

test('loadBroker fails closed when the broker module cannot be required', () => {
  const requireFn = () => { throw new Error('Cannot find module'); };
  assert.throws(
    () => loadBroker({ PAY_PERIOD_TRACKER_ROOT: '/nonexistent' }, requireFn),
    /TN_ACCOUNT_SYSTEM=1 but the TN account broker could not be loaded/,
  );
});

test('loadBroker fails closed when the broker is missing expected exports', () => {
  const requireFn = (p) => {
    if (p.endsWith('tn-account-broker.js')) return { resolveAccountForRun: undefined };
    return {};
  };
  assert.throws(
    () => loadBroker({}, requireFn),
    /did not export the expected broker API/,
  );
});

test('loadBroker fails closed when readLoggedInUsername is missing from schedule-browser', () => {
  const requireFn = (p) => {
    if (p.endsWith('tn-account-broker.js')) {
      return {
        resolveAccountForRun: () => {},
        acquireAccountSession: () => {},
        identityGate: { assertIdentity: () => {} },
        registry: { assertRegistryMatch: () => {} },
        markers: {},
        doppler: {},
      };
    }
    if (p.endsWith('schedule-browser.js')) return { readLoggedInUsername: undefined };
    return {};
  };
  assert.throws(
    () => loadBroker({}, requireFn),
    /does not export readLoggedInUsername/,
  );
});

test('loadBroker succeeds and merges readLoggedInUsername when everything is present', () => {
  const fakeBroker = {
    resolveAccountForRun: () => {},
    acquireAccountSession: () => {},
    identityGate: { assertIdentity: () => {} },
    registry: { assertRegistryMatch: () => {} },
    markers: {},
    doppler: {},
  };
  const fakeReadUsername = () => 'blta';
  const requireFn = (p) => {
    if (p.endsWith('tn-account-broker.js')) return fakeBroker;
    if (p.endsWith('schedule-browser.js')) return { readLoggedInUsername: fakeReadUsername };
    throw new Error(`unexpected require: ${p}`);
  };
  const broker = loadBroker({}, requireFn);
  assert.equal(broker.readLoggedInUsername, fakeReadUsername);
  assert.equal(broker.resolveAccountForRun, fakeBroker.resolveAccountForRun);
});
