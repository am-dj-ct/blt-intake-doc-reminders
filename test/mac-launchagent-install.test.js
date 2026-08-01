"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { replaceOneLaunchAgent } = require("../scripts/launchagent-transaction");
const installer = require("../scripts/install-mac-launchagent");

const root = path.join(__dirname, "..");
const installerSource = fs.readFileSync(path.join(root, "scripts", "install-mac-launchagent.js"), "utf8");
const wrapper = fs.readFileSync(path.join(root, "run.sh"), "utf8");

function fixture(failAt = "", rollbackMismatch = false, disabledState = "enabled") {
  const snapshot = { exists: true, content: "old", loaded: true, disabledState, disabled: disabledState === "disabled" };
  const state = { ...snapshot };
  let rollingBack = false;
  const fail = (name) => { if (!rollingBack && failAt === name) throw new Error(`${name} failed`); };
  const operations = {
    newContent: "new",
    bootout: async () => { if (state.content === "new") rollingBack = true; state.loaded = false; },
    writeNew: async () => { fail("write"); state.exists = true; state.content = "new"; },
    write: async (content) => { state.exists = true; state.content = content; },
    remove: async () => { state.exists = false; state.content = null; },
    enable: async () => { fail("enable"); state.disabledState = "enabled"; state.disabled = false; },
    disable: async () => { state.disabledState = "disabled"; state.disabled = true; },
    bootstrap: async () => { fail("bootstrap"); state.loaded = true; },
    inspect: async () => rollbackMismatch && rollingBack ? { ...state, loaded: false } : { ...state },
  };
  return { snapshot, state, operations };
}

test("installer and runtime wrapper require exact app and broker attestations", () => {
  assert.match(installerSource, /const ROOT = "\/Users\/alexmercer\/blt-intake-doc-reminders"/);
  assert.match(installerSource, /TN_ACCOUNT_BROKER_EXPECTED_HEAD/);
  assert.match(installerSource, /TN_ACCOUNT_BROKER_EXPECTED_TREE/);
  assert.match(installerSource, /BLT_INTAKE_DOC_REMINDERS_EXPECTED_HEAD/);
  assert.match(installerSource, /BLT_INTAKE_DOC_REMINDERS_EXPECTED_TREE/);
  assert.match(installerSource, /verifyRuntimeCheckout/);
  assert.match(wrapper, /verify-runtime-checkout[.]js/);
  assert.match(wrapper, /export TN_ACCOUNT=blta/);
  assert.match(wrapper, /doppler run --silent --no-fallback/);
  assert.doesNotMatch(wrapper, /PAY_PERIOD_TRACKER_ROOT|THERAPY_HOURS_TN_USERNAME|TN_USERNAME/);
  assert.equal(fs.existsSync(path.join(root, "com.blt.intake-doc-reminders.plist")), false);
});

test("rendered launch agent carries two exact reviewed pairs and 14 hourly intervals", () => {
  const content = installer.render({
    ownHead: "a".repeat(40),
    ownTree: "b".repeat(40),
    brokerRoot: "/Users/alexmercer/.openclaw/runtime/therapynotes-ppt-cccccccccccc",
    brokerHead: "c".repeat(40),
    brokerTree: "d".repeat(40),
  });
  assert.match(content, /<key>TN_ACCOUNT_SYSTEM<\/key><string>1<\/string>/);
  assert.match(content, /<key>TN_ACCOUNT<\/key><string>blta<\/string>/);
  assert.equal((content.match(/<key>Hour<\/key>/g) || []).length, 14);
  assert.match(content, /node@22/);
});

for (const failure of ["write", "enable", "bootstrap"]) {
  test(`${failure} failure restores plist, loaded state, and disabled state`, async () => {
    const { snapshot, state, operations } = fixture(failure);
    await assert.rejects(() => replaceOneLaunchAgent({ snapshot, operations }), /prior state was verified restored/);
    assert.deepEqual(state, snapshot);
  });
}

test("rollback verification failure is reported as incomplete", async () => {
  const { snapshot, operations } = fixture("bootstrap", true);
  await assert.rejects(() => replaceOneLaunchAgent({ snapshot, operations }), /rollback is incomplete/);
});
