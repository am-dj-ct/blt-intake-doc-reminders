#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function sanitizedGitEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) if (!key.startsWith("GIT_")) env[key] = value;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_COUNT = "0";
  return env;
}

function gitOutput(root, args, sourceEnv = process.env) {
  return execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8",
    env: sanitizedGitEnv(sourceEnv),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function verifyRuntimeCheckout({ root, expectedHead, expectedTree, sourceEnv = process.env }) {
  if (!root || !path.isAbsolute(root) || path.resolve(root) !== root) throw new Error("runtime root must be normalized and absolute");
  if (!/^[0-9a-f]{40}$/.test(expectedHead || "") || !/^[0-9a-f]{40}$/.test(expectedTree || "")) {
    throw new Error("runtime head and tree must be exact");
  }
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("runtime root must be a real directory");
  const top = gitOutput(root, ["rev-parse", "--show-toplevel"], sourceEnv);
  const head = gitOutput(root, ["rev-parse", "HEAD"], sourceEnv);
  const tree = gitOutput(root, ["rev-parse", "HEAD^{tree}"], sourceEnv);
  const dirty = gitOutput(root, ["status", "--porcelain"], sourceEnv);
  if (top !== root || head !== expectedHead || tree !== expectedTree || dirty) {
    throw new Error("runtime checkout does not match the clean reviewed root, head, and tree");
  }
  return { root, head, tree, clean: true };
}

function cli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  const result = verifyRuntimeCheckout({
    root: values["--root"],
    expectedHead: values["--head"],
    expectedTree: values["--tree"],
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (require.main === module) {
  try { cli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}

module.exports = { sanitizedGitEnv, gitOutput, verifyRuntimeCheckout };
