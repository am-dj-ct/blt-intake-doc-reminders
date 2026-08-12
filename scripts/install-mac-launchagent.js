#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { replaceOneLaunchAgent } = require("./launchagent-transaction");
const { parseLaunchctlDisabledState } = require("./launchctl-disabled-state");
const { verifyRuntimeCheckout } = require("./verify-runtime-checkout");

const ROOT = "/Users/alexmercer/blt-intake-doc-reminders";
const BROKER_RUNTIME_BASE = "/Users/alexmercer/.openclaw/runtime";
const HOME = "/Users/alexmercer";
const UID = 501;
const LABEL = "com.blt.intake-doc-reminders";
const PLIST = `${HOME}/Library/LaunchAgents/${LABEL}.plist`;
const LOG_DIR = `${ROOT}/data`;
const BACKUP_ROOT = `${HOME}/.blt-automation/backups/intake-doc-reminders-launchagent`;

function fail(message, code = 1) { process.stderr.write(`${message}\n`); process.exit(code); }

function exactCheckout(name, root, expectedHead, expectedTree) {
  try { verifyRuntimeCheckout({ root, expectedHead, expectedTree }); }
  catch { fail(`${name} checkout is not the clean reviewed root, head, and tree`, 65); }
}

function intervals() {
  return Array.from({ length: 14 }, (_, index) => index + 7)
    .map((hour) => `    <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>35</integer></dict>`)
    .join("\n");
}

function render({ ownHead, ownTree, brokerRoot, brokerHead, brokerTree }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TN_ACCOUNT_SYSTEM</key><string>1</string>
    <key>TN_ACCOUNT</key><string>blta</string>
    <key>BLT_INTAKE_DOC_REMINDERS_EXPECTED_HEAD</key><string>${ownHead}</string>
    <key>BLT_INTAKE_DOC_REMINDERS_EXPECTED_TREE</key><string>${ownTree}</string>
    <key>TN_ACCOUNT_BROKER_ROOT</key><string>${brokerRoot}</string>
    <key>TN_ACCOUNT_BROKER_EXPECTED_HEAD</key><string>${brokerHead}</string>
    <key>TN_ACCOUNT_BROKER_EXPECTED_TREE</key><string>${brokerTree}</string>
  </dict>
  <key>ProgramArguments</key><array><string>${ROOT}/run.sh</string></array>
  <key>StartCalendarInterval</key>
  <array>
${intervals()}
  </array>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/run.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/run.log</string>
</dict>
</plist>
`;
}

function launchctl(args) {
  return execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function loaded() {
  try { launchctl(["print", `gui/${UID}/${LABEL}`]); return true; }
  catch (error) {
    const detail = `${error.stderr || ""}`;
    if (error.status === 113 || /could not find service|not found/i.test(detail)) return false;
    throw error;
  }
}

function disabledState() {
  return parseLaunchctlDisabledState(launchctl(["print-disabled", `gui/${UID}`]), LABEL);
}

function inspect() {
  const exists = fs.existsSync(PLIST);
  const launchdState = disabledState();
  return {
    exists,
    content: exists ? fs.readFileSync(PLIST, "utf8") : null,
    loaded: loaded(),
    disabledState: launchdState,
    disabled: launchdState === "disabled",
  };
}

function atomicWrite(target, content) {
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

async function main() {
  const mode = process.argv[2] || "--install";
  if (!["--check", "--install"].includes(mode)) fail("usage: install-mac-launchagent.js [--check|--install]", 64);
  const ownHead = process.env.BLT_INTAKE_DOC_REMINDERS_EXPECTED_HEAD || "";
  const ownTree = process.env.BLT_INTAKE_DOC_REMINDERS_EXPECTED_TREE || "";
  const brokerHead = process.env.TN_ACCOUNT_BROKER_EXPECTED_HEAD || "";
  const brokerTree = process.env.TN_ACCOUNT_BROKER_EXPECTED_TREE || "";
  if (!/^[0-9a-f]{40}$/.test(ownHead) || !/^[0-9a-f]{40}$/.test(ownTree) ||
      !/^[0-9a-f]{40}$/.test(brokerHead) || !/^[0-9a-f]{40}$/.test(brokerTree)) {
    fail("application and broker heads and trees must be exact", 64);
  }
  const brokerRoot = `${BROKER_RUNTIME_BASE}/therapynotes-ppt-${brokerHead.slice(0, 12)}`;
  if (process.env.TN_ACCOUNT_BROKER_ROOT !== brokerRoot) fail("canonical broker root is not the exact immutable install", 64);
  exactCheckout("intake reminders", ROOT, ownHead, ownTree);
  exactCheckout("canonical broker", brokerRoot, brokerHead, brokerTree);
  const newContent = render({ ownHead, ownTree, brokerRoot, brokerHead, brokerTree });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true, mode: 0o700 });
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(`${HOME}/.blt-automation`, { recursive: true, mode: 0o700 });
  const lintDir = fs.mkdtempSync(`${HOME}/.blt-automation/intake-reminder-plist-lint-`);
  fs.chmodSync(lintDir, 0o700);
  try {
    const lintPath = path.join(lintDir, `${LABEL}.plist`);
    atomicWrite(lintPath, newContent);
    execFileSync("/usr/bin/plutil", ["-lint", lintPath], { stdio: "ignore" });
  } finally { fs.rmSync(lintDir, { recursive: true, force: true }); }
  if (mode === "--check") {
    process.stdout.write(`${JSON.stringify({ ok: true, root: ROOT, ownHead, ownTree, brokerRoot, brokerHead, brokerTree })}\n`);
    return;
  }

  const snapshot = inspect();
  const backupDir = `${BACKUP_ROOT}/${new Date().toISOString().replaceAll(":", "")}-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (snapshot.exists) atomicWrite(path.join(backupDir, `${LABEL}.plist`), snapshot.content);
  atomicWrite(path.join(backupDir, "state.json"), `${JSON.stringify({ ...snapshot, content: undefined })}\n`);
  const operations = {
    newContent,
    bootout: async () => { if (loaded()) launchctl(["bootout", `gui/${UID}/${LABEL}`]); },
    writeNew: async () => atomicWrite(PLIST, newContent),
    write: async (content) => atomicWrite(PLIST, content),
    remove: async () => fs.rmSync(PLIST, { force: true }),
    enable: async () => launchctl(["enable", `gui/${UID}/${LABEL}`]),
    disable: async () => launchctl(["disable", `gui/${UID}/${LABEL}`]),
    bootstrap: async () => launchctl(["bootstrap", `gui/${UID}`, PLIST]),
    inspect: async () => inspect(),
  };
  await replaceOneLaunchAgent({ snapshot, operations });
  process.stdout.write(`${JSON.stringify({ ok: true, installed: true, root: ROOT, ownHead, ownTree, brokerRoot, brokerHead, brokerTree, backupDir })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    if (error.cause) process.stderr.write(`${error.cause.message}\n`);
    process.exit(1);
  });
}

module.exports = { render, intervals };
