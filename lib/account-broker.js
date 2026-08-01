"use strict";

// Read-only seam onto the exact reviewed pay-period-tracker TherapyNotes
// broker. The broker runtime is installed separately and made immutable;
// callers cannot select an ordinary checkout or a different path.

const fs = require("node:fs");
const path = require("node:path");
const { verifyRuntimeCheckout } = require("../scripts/verify-runtime-checkout");

const BROKER_RUNTIME_BASE = "/Users/alexmercer/.openclaw/runtime";

function resolveBrokerRoot(env = process.env) {
  const head = String(env.TN_ACCOUNT_BROKER_EXPECTED_HEAD || "").trim();
  const tree = String(env.TN_ACCOUNT_BROKER_EXPECTED_TREE || "").trim();
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(tree)) {
    throw new Error("TherapyNotes broker head and tree are not exactly pinned.");
  }
  const expected = `${BROKER_RUNTIME_BASE}/therapynotes-ppt-${head.slice(0, 12)}`;
  const selected = String(env.TN_ACCOUNT_BROKER_ROOT || "").trim();
  if (!selected || !path.isAbsolute(selected) || path.resolve(selected) !== selected || selected !== expected) {
    throw new Error("TherapyNotes broker root is not the exact immutable install.");
  }
  return selected;
}

function attestFrozenRuntimePath(root) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const parsed = path.parse(root);
  const components = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let userOwnedAncestor = uid === null;
  for (const component of components) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("TherapyNotes broker path is not trusted.");
    if (uid !== null) {
      const ownedByUser = stat.uid === uid;
      const ownedByRoot = stat.uid === 0;
      if (userOwnedAncestor && !ownedByUser) throw new Error("TherapyNotes broker path leaves trusted ownership.");
      if (!ownedByUser && !ownedByRoot) throw new Error("TherapyNotes broker path has an untrusted owner.");
      const writableByOthers = (stat.mode & 0o022) !== 0;
      const protectedSystemAncestor = ownedByRoot && (stat.mode & 0o1000) !== 0 && !userOwnedAncestor;
      if (writableByOthers && !protectedSystemAncestor) throw new Error("TherapyNotes broker ancestry is writable by another principal.");
      if (ownedByUser) userOwnedAncestor = true;
    }
  }
  if (!userOwnedAncestor) throw new Error("TherapyNotes broker path has no trusted user-owned ancestor.");
  const visit = (target) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o222) !== 0) {
      throw new Error("TherapyNotes broker runtime is not frozen and owner-controlled.");
    }
    if (stat.isDirectory()) for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
    else if (!stat.isFile()) throw new Error("TherapyNotes broker runtime contains an unsupported entry.");
  };
  visit(root);
}

function checkedTestDeps(env, deps) {
  if (!deps || Reflect.ownKeys(deps).length === 0) return {};
  if (env.NODE_ENV !== "test" || deps.testOnly !== true) {
    throw new Error("TherapyNotes broker dependency injection is test-only.");
  }
  return deps;
}

function loadBroker(env = process.env, deps = {}) {
  deps = checkedTestDeps(env, deps);
  const root = resolveBrokerRoot(env);
  const verify = deps.verifyRuntimeCheckout || verifyRuntimeCheckout;
  const attest = deps.attestFrozenRuntimePath || attestFrozenRuntimePath;
  const requireFn = deps.requireFn || require;
  attest(root);
  verify({
    root,
    expectedHead: String(env.TN_ACCOUNT_BROKER_EXPECTED_HEAD || "").trim(),
    expectedTree: String(env.TN_ACCOUNT_BROKER_EXPECTED_TREE || "").trim(),
  });
  const brokerPath = path.join(root, "src", "therapynotes", "tn-account-broker.js");
  const schedulePath = path.join(root, "src", "therapynotes", "schedule-browser.js");
  let broker;
  let schedule;
  try {
    broker = requireFn(brokerPath);
    schedule = requireFn(schedulePath);
  } catch (error) {
    throw new Error("The exact reviewed TherapyNotes broker could not be loaded; refusing browser launch.", { cause: error });
  }
  for (const [name, value] of [
    ["resolveAccountForRun", broker?.resolveAccountForRun],
    ["acquireAccountSession", broker?.acquireAccountSession],
    ["withPreWorkAccountFailover", broker?.withPreWorkAccountFailover],
    ["confirmPreWorkFailoverCleanup", broker?.confirmPreWorkFailoverCleanup],
    ["identityGate.assertIdentity", broker?.identityGate?.assertIdentity],
    ["lock.killProfileDirAndConfirm", broker?.lock?.killProfileDirAndConfirm],
    ["doppler.createDopplerReader", broker?.doppler?.createDopplerReader],
    ["doppler.createDopplerWriter", broker?.doppler?.createDopplerWriter],
    ["therapyNotesLoginVisible", schedule?.therapyNotesLoginVisible],
    ["performAccountBrokerLogin", schedule?.performAccountBrokerLogin],
    ["readLoggedInUsername", schedule?.readLoggedInUsername],
    ["isTherapyNotesAppUrlFamily", schedule?.isTherapyNotesAppUrlFamily],
  ]) {
    if (typeof value !== "function") throw new Error(`The exact reviewed TherapyNotes broker is missing ${name}.`);
  }
  return Object.freeze({
    ...broker,
    therapyNotesLoginVisible: schedule.therapyNotesLoginVisible,
    performAccountBrokerLogin: schedule.performAccountBrokerLogin,
    readLoggedInUsername: schedule.readLoggedInUsername,
    isTherapyNotesAppUrlFamily: schedule.isTherapyNotesAppUrlFamily,
  });
}

module.exports = {
  BROKER_RUNTIME_BASE,
  resolveBrokerRoot,
  attestFrozenRuntimePath,
  loadBroker,
};
