"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { gitOutput, verifyRuntimeCheckout } = require("../scripts/verify-runtime-checkout");

function checkout() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "intake-runtime-attestation-")));
  execFileSync("/usr/bin/git", ["-C", root, "init", "-q"]);
  execFileSync("/usr/bin/git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("/usr/bin/git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(root, "runtime.js"), "module.exports = true;\n");
  execFileSync("/usr/bin/git", ["-C", root, "add", "runtime.js"]);
  execFileSync("/usr/bin/git", ["-C", root, "commit", "-qm", "runtime"]);
  return { root, head: gitOutput(root, ["rev-parse", "HEAD"]), tree: gitOutput(root, ["rev-parse", "HEAD^{tree}"]) };
}

test("runtime attestation ignores hostile Git redirection and config", () => {
  const candidate = checkout();
  const hostile = {
    ...process.env,
    GIT_DIR: "/tmp/attacker.git",
    GIT_WORK_TREE: "/tmp/attacker-worktree",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: "/tmp/attacker-worktree",
  };
  assert.deepEqual(verifyRuntimeCheckout({ ...candidate, expectedHead: candidate.head, expectedTree: candidate.tree, sourceEnv: hostile }), {
    ...candidate,
    clean: true,
  });
});

test("runtime attestation refuses dirty state and head or tree drift", () => {
  const candidate = checkout();
  fs.appendFileSync(path.join(candidate.root, "runtime.js"), "// drift\n");
  assert.throws(() => verifyRuntimeCheckout({ root: candidate.root, expectedHead: candidate.head, expectedTree: candidate.tree }), /does not match/);
  execFileSync("/usr/bin/git", ["-C", candidate.root, "checkout", "--", "runtime.js"]);
  assert.throws(() => verifyRuntimeCheckout({ root: candidate.root, expectedHead: "0".repeat(40), expectedTree: candidate.tree }), /does not match/);
  assert.throws(() => verifyRuntimeCheckout({ root: candidate.root, expectedHead: candidate.head, expectedTree: "0".repeat(40) }), /does not match/);
});
