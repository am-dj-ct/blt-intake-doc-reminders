#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function usage() {
  throw new Error("usage: run-with-timeout.js --timeout-seconds N --status-path PATH -- command [args...]");
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) usage();
  const options = argv.slice(0, separator);
  const command = argv.slice(separator);
  const out = { command: command.slice(1), timeoutSeconds: null, statusPath: null, killGraceSeconds: 10 };
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i];
    const value = options[i + 1];
    if (value == null) usage();
    if (key === "--timeout-seconds") out.timeoutSeconds = Number(value);
    else if (key === "--kill-grace-seconds") out.killGraceSeconds = Number(value);
    else if (key === "--status-path") out.statusPath = value;
    else usage();
  }
  if (!Number.isInteger(out.timeoutSeconds) || out.timeoutSeconds < 1) usage();
  if (!Number.isInteger(out.killGraceSeconds) || out.killGraceSeconds < 1) usage();
  if (!out.statusPath) usage();
  return out;
}

function writeTimeoutStatus(statusPath, timeoutSeconds) {
  const status = {
    ranAt: new Date().toISOString(),
    health: "red",
    alertCode: "run_timeout",
    timedOut: true,
    timeoutSeconds,
    zeroIntakeCandidateStreak: 0,
  };
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const temporary = `${statusPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(status, null, 2));
  fs.renameSync(temporary, statusPath);
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

function exitCodeForSignal(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  return 128 + (numbers[signal] || 1);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const [command, ...args] = options.command;
  const child = spawn(command, args, {
    detached: true,
    stdio: "inherit",
    env: process.env,
  });
  let timedOut = false;
  let forwardedSignal = null;
  let killTimer = null;

  const timeout = setTimeout(() => {
    timedOut = true;
    try { writeTimeoutStatus(options.statusPath, options.timeoutSeconds); }
    catch (error) { process.stderr.write(`[timeout] could not write red status artifact: ${error.message}\n`); }
    process.stderr.write(`[timeout] run exceeded ${options.timeoutSeconds}s; terminating its process group\n`);
    signalGroup(child.pid, "SIGTERM");
    killTimer = setTimeout(() => {
      process.stderr.write("[timeout] process group did not stop after SIGTERM; sending SIGKILL\n");
      signalGroup(child.pid, "SIGKILL");
    }, options.killGraceSeconds * 1000);
  }, options.timeoutSeconds * 1000);

  const forward = (signal) => {
    forwardedSignal = signal;
    signalGroup(child.pid, signal);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));

  child.once("error", (error) => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    process.stderr.write(`[timeout] could not start run: ${error.message}\n`);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    if (timedOut) process.exit(124);
    if (forwardedSignal) process.exit(exitCodeForSignal(forwardedSignal));
    if (signal) process.exit(exitCodeForSignal(signal));
    process.exit(code == null ? 1 : code);
  });
}

if (require.main === module) main();

module.exports = { parseArgs, writeTimeoutStatus };
