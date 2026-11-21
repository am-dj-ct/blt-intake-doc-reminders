"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROFILE_CLEANUP_TIMEOUT_MS = 60_000;
const HELPER = path.join(__dirname, "..", "scripts", "cleanup-tn-profile.js");

// Promise.race cannot interrupt the broker's synchronous profile fingerprint.
// A separate process can: SIGKILL and waitpid finish before release continues.
function runBoundedCleanup(operation, payload, { timeoutMs = PROFILE_CLEANUP_TIMEOUT_MS,
  execute = execFileSync } = {}) {
  try {
    const output = execute(process.execPath, [HELPER, operation], {
      input: JSON.stringify(payload), encoding: "utf8", timeout: timeoutMs,
      killSignal: "SIGKILL", maxBuffer: 4096, stdio: ["pipe", "pipe", "pipe"],
    });
    return output ? JSON.parse(output) : undefined;
  } catch (cause) {
    const timedOut = cause.code === "ETIMEDOUT";
    const error = new Error(`TherapyNotes profile ${operation} ${timedOut ? "timed out" : "failed"}.`);
    error.alertCode = timedOut ? "tn_profile_cleanup_timeout" : "tn_profile_cleanup_failed";
    error.stage = `profile_${operation}`;
    error.timeoutMs = timeoutMs;
    try {
      const code = JSON.parse(String(cause.stderr)).code;
      if (["session_envelope_mismatch", "session_envelope_permissions", "session_envelope_symlink", "session_envelope_invalid", "session_envelope_path_untrusted"].includes(code)) error.code = code;
    } catch { /* Child output is deliberately not included in the error. */ }
    // Child output may include local paths. Keep diagnostic output counts-only.
    throw error;
  }
}

function installBoundedProfileCleanup(broker, root) {
  if (typeof broker.sessionEnvelope?.refreshSessionEnvelope !== "function" || typeof broker.sessionEnvelope.ensureSessionEnvelope !== "function") {
    throw new Error("The exact reviewed TherapyNotes broker is missing sessionEnvelope.refreshSessionEnvelope.");
  }
  // release() intentionally remains the canonical broker closure, including
  // its timer shutdown, envelope requirement and exact-owner lock release.
  broker.sessionEnvelope.refreshSessionEnvelope = ({ profileDir, account, machineIdPath, bearerFiles = [] }) =>
    runBoundedCleanup("seal", { root, profileDir, account, machineIdPath, bearerFiles });
  broker.sessionEnvelope.ensureSessionEnvelope = ({ profileDir, account, machineIdPath, bearerFiles = [] }) =>
    runBoundedCleanup("ensure", { root, profileDir, account, machineIdPath, bearerFiles });
  return {
    secureProfileForRelease: (profileDir) => runBoundedCleanup("secure", { root, profileDir }),
    prepareProfileForLaunch: (profileDir, forceQuarantine) => runBoundedCleanup("prepare", { root, profileDir, forceQuarantine }),
    purgeRetiredCaches: (profileDir) => runBoundedCleanup("purge", { root, profileDir }),
  };
}

module.exports = { PROFILE_CLEANUP_TIMEOUT_MS, runBoundedCleanup, installBoundedProfileCleanup };
