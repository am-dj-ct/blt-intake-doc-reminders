"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BROKER_RUNTIME_BASE,
  resolveBrokerRoot,
  attestFrozenRuntimePath,
  loadBroker,
} = require("../lib/account-broker");

const head = "a".repeat(40);
const tree = "b".repeat(40);
const root = `${BROKER_RUNTIME_BASE}/therapynotes-ppt-${head.slice(0, 12)}`;

function env(overrides = {}) {
  return {
    NODE_ENV: "test",
    TN_ACCOUNT_BROKER_ROOT: root,
    TN_ACCOUNT_BROKER_EXPECTED_HEAD: head,
    TN_ACCOUNT_BROKER_EXPECTED_TREE: tree,
    ...overrides,
  };
}

function modules() {
  const broker = {
    resolveAccountForRun: async () => {},
    acquireAccountSession: async () => {},
    withPreWorkAccountFailover: async (fn) => fn({ attempt: 0 }),
    confirmPreWorkFailoverCleanup: () => {},
    identityGate: { assertIdentity: () => ({ ok: true }) },
    lock: { killProfileDirAndConfirm: async () => ({ confirmed: true }) },
    doppler: { createDopplerReader: () => async () => "", createDopplerWriter: () => async () => {} },
  };
  const schedule = {
    therapyNotesLoginVisible: async () => false,
    performAccountBrokerLogin: async () => {},
    readLoggedInUsername: async () => "synthetic",
    isTherapyNotesAppUrlFamily: () => true,
  };
  return { broker, schedule };
}

function testDeps(overrides = {}) {
  const fake = modules();
  return {
    testOnly: true,
    attestFrozenRuntimePath: () => {},
    verifyRuntimeCheckout: () => ({ root, head, tree, clean: true }),
    requireFn: (target) => target.endsWith("tn-account-broker.js") ? fake.broker : fake.schedule,
    ...overrides,
  };
}

test("broker root requires exact head, tree, and immutable path", () => {
  assert.equal(resolveBrokerRoot(env()), root);
  for (const invalid of [
    env({ TN_ACCOUNT_BROKER_EXPECTED_HEAD: "" }),
    env({ TN_ACCOUNT_BROKER_EXPECTED_TREE: "short" }),
    env({ TN_ACCOUNT_BROKER_ROOT: "/Users/alexmercer/pay-period-tracker" }),
    env({ TN_ACCOUNT_BROKER_ROOT: `${root}/..` }),
  ]) assert.throws(() => resolveBrokerRoot(invalid), /not exactly pinned|not the exact immutable install/);
});

test("loadBroker verifies the exact checkout before requiring canonical modules", () => {
  const events = [];
  const deps = testDeps({
    attestFrozenRuntimePath: (selected) => events.push(["attest", selected]),
    verifyRuntimeCheckout: (options) => events.push(["verify", options]),
  });
  const broker = loadBroker(env(), deps);
  assert.equal(typeof broker.withPreWorkAccountFailover, "function");
  assert.equal(typeof broker.performAccountBrokerLogin, "function");
  assert.deepEqual(events.map(([name]) => name), ["attest", "verify"]);
  assert.equal(events[1][1].expectedHead, head);
  assert.equal(events[1][1].expectedTree, tree);
});

test("production cannot inject a fake broker or skip attestation", () => {
  assert.throws(() => loadBroker({ ...env(), NODE_ENV: "production" }, testDeps()), /test-only/);
});

test("missing canonical APIs fail closed", () => {
  const fake = modules();
  delete fake.broker.withPreWorkAccountFailover;
  assert.throws(() => loadBroker(env(), testDeps({
    requireFn: (target) => target.endsWith("tn-account-broker.js") ? fake.broker : fake.schedule,
  })), /missing withPreWorkAccountFailover/);
});

test("frozen runtime attestation refuses writable state and symlinks", () => {
  const candidate = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "intake-broker-frozen-")));
  const file = path.join(candidate, "module.js");
  fs.writeFileSync(file, "module.exports = true;\n", { mode: 0o400 });
  fs.chmodSync(candidate, 0o500);
  attestFrozenRuntimePath(candidate);
  fs.chmodSync(candidate, 0o700);
  fs.symlinkSync(file, path.join(candidate, "link"));
  fs.chmodSync(candidate, 0o500);
  assert.throws(() => attestFrozenRuntimePath(candidate), /not frozen|unsupported|symlink|owner-controlled/);
  fs.chmodSync(candidate, 0o700);
});
