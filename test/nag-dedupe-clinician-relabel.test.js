"use strict";

// Reproduces the 2026-09-28 double-send: the same client's intake nag went
// out twice in one day because the ledger's "already sent" key was built
// from it.patientId, and classifyAppointment() re-derived a *different*
// patient id for the same client + appointment slot after TN relabeled which
// clinician's column the appointment was filed under between hourly runs.
// Synthetic data only; no real client names, ids, or appointment details.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { dispatch } = require("../index");
const realLedger = require("../lib/ledger");

function makeLedgerDeps(ledgerPath) {
  return {
    key: realLedger.key,
    save: (set) => realLedger.save(set, ledgerPath),
  };
}

test("a clinician-column relabel between runs must not resend the same client's nag", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-nag-dedupe-"));
  const ledgerPath = path.join(dir, "sent.json");
  const sends = [];
  const opts = { dryRun: false, test: false, force: false };
  const start = new Date("2099-09-29T18:00:00.000Z");

  // Run 1 (14:35Z equivalent): appointment classified under clinician "A",
  // patient id read as "patient-A". Nag goes out and is recorded.
  const intakeUnderClinicianA = {
    patientId: "synthetic-patient-A",
    client: "Synthetic Client",
    clinician: "Synthetic Clinician A",
    start,
    missing: ["SOD"],
  };
  let sent = realLedger.load(ledgerPath);
  const outcome1 = await dispatch("nag", intakeUnderClinicianA, new Date("2099-09-28T14:35:00.000Z"), sent, opts, {
    sendEmail: async (msg) => sends.push(msg),
    ledger: makeLedgerDeps(ledgerPath),
  });
  assert.equal(outcome1, "sent");
  assert.equal(sends.length, 1);

  // Runs in between (15:35Z-19:35Z equivalent): fresh process, ledger
  // reloaded from disk, same clinician label still cached -> correctly skip.
  sent = realLedger.load(ledgerPath);
  const outcomeSkip = await dispatch("nag", intakeUnderClinicianA, new Date("2099-09-28T15:35:00.000Z"), sent, opts, {
    sendEmail: async (msg) => sends.push(msg),
    ledger: makeLedgerDeps(ledgerPath),
  });
  assert.equal(outcomeSkip, "already-sent");
  assert.equal(sends.length, 1);

  // Run 2 (20:35Z equivalent): TN now files the SAME appointment (same
  // client, same start time, same stage) under a different clinician's
  // column. That changes the classify-cache key upstream, so a fresh
  // classifyAppointment() call runs and comes back with a DIFFERENT patient
  // id for the same real appointment -- this is the exact condition that
  // caused the resend on 2026-09-28. Dedupe must key on the client, not the
  // re-derived patient id, so this must now skip.
  const intakeUnderClinicianB = {
    patientId: "synthetic-patient-B",
    client: "Synthetic Client",
    clinician: "Synthetic Clinician B",
    start,
    missing: ["SOD"],
  };
  sent = realLedger.load(ledgerPath);
  const outcome2 = await dispatch("nag", intakeUnderClinicianB, new Date("2099-09-28T20:35:00.000Z"), sent, opts, {
    sendEmail: async (msg) => sends.push(msg),
    ledger: makeLedgerDeps(ledgerPath),
  });

  assert.equal(outcome2, "already-sent");
  assert.equal(sends.length, 1, "client must receive at most one nag per intake appointment");

  fs.rmSync(dir, { recursive: true, force: true });
});
