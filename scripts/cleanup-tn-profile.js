"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveBrokerRoot } = require("../lib/account-broker");
const { JOB_NAME, NORMAL_ACCOUNTS, profileDirFor, securePathTree, prepareProfileForLaunch } = require("../lib/tn-account-session");

function cleanupProfile(operation, payload, { broker, parentPid = process.ppid } = {}) {
  if (!["secure", "seal", "ensure", "prepare", "purge"].includes(operation)) throw new Error("Invalid cleanup operation.");
  const account = payload.account || NORMAL_ACCOUNTS.find((name) => profileDirFor(name) === payload.profileDir);
  if (!NORMAL_ACCOUNTS.includes(account) || payload.profileDir !== profileDirFor(account)) throw new Error("Invalid cleanup profile.");
  if (operation === "purge") return require("../lib/profile-cache").purgeRetiredCaches(payload.profileDir);
  const lockDir = broker.lock.lockDirFor(account);
  const owner = broker.lock.readOwner(lockDir);
  if (!owner || owner.pid !== parentPid || owner.jobName !== JOB_NAME || owner.browserProfileDir !== payload.profileDir ||
      !broker.lock.verifyStillOwner(lockDir, owner).ok) throw new Error("Cleanup ownership not confirmed.");
  if (broker.lock.createLockDeps().listProcessesByProfileDir(payload.profileDir).length) throw new Error("Cleanup browser still alive.");
  if (operation === "secure") {
    securePathTree(payload.profileDir, { lockOwnershipVerified: true, discardDiskCache: true });
  } else if (operation === "prepare") {
    return prepareProfileForLaunch(payload.profileDir, { lockOwnershipVerified: true,
      forceQuarantine: payload.forceQuarantine === true, discardDiskCache: true });
  } else {
    return broker.sessionEnvelope[operation === "ensure" ? "ensureSessionEnvelope" : "refreshSessionEnvelope"]({ profileDir: payload.profileDir, account,
      machineIdPath: payload.machineIdPath, bearerFiles: payload.bearerFiles });
  }
}

if (require.main === module) {
  try {
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    if (payload.root !== resolveBrokerRoot()) throw new Error("Cleanup broker pin mismatch.");
    const broker = require(path.join(payload.root, "src", "therapynotes", "tn-account-broker.js"));
    const result = cleanupProfile(process.argv[2], payload, { broker });
    process.stdout.write(JSON.stringify(result || { ok: true }));
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: error.code || "cleanup_failed" }));
    process.exitCode = 1;
  }
}

module.exports = { cleanupProfile };
