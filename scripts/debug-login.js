#!/usr/bin/env node
"use strict";

// PHI-free broker diagnostic. It uses the exact production session seam and
// reports only the selected account code after login + identity proof.

const { openTnSession } = require("../index");

(async () => {
  const opened = await openTnSession({ headful: process.argv.includes("--headful") });
  if (opened.skip) {
    process.stdout.write(`TherapyNotes broker skipped: ${opened.reason || "busy"}\n`);
    return;
  }
  try { process.stdout.write(`TherapyNotes broker identity verified on ${opened.account}.\n`); }
  finally { await opened.release(); }
})().catch((error) => {
  process.stderr.write(`TherapyNotes broker diagnostic failed: ${error.message}\n`);
  process.exit(1);
});
