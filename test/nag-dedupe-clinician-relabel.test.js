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

test("legacy patient-id-keyed ledger entries migrate forward without resending", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-nag-migrate-"));
  const ledgerPath = path.join(dir, "sent.json");
  const start = new Date("2099-09-29T18:00:00.000Z");
  const stage = "nag";

  // Simulate the pre-fix ledger: two legacy, patient-id-keyed entries for
  // the SAME client + appointment slot (the double-send itself), because two
  // different clinician labels were cached across runs.
  const legacyKeyA = `synthetic-patient-A@${start.toISOString()}#${stage}`;
  const legacyKeyB = `synthetic-patient-B@${start.toISOString()}#${stage}`;
  realLedger.save(new Set([legacyKeyA, legacyKeyB]), ledgerPath);

  // Simulate the classify cache (data/appts.json) as it would look after the
  // clinician relabel: two entries, different clinicians, same client and
  // time, one patient id each -- matching the two legacy ledger keys above.
  const cache = {
    "Synthetic Clinician A|Synthetic Client|2099-09-29T18:00:00.000Z": { patientId: "synthetic-patient-A", isIntake: true, isTelehealth: true },
    "Synthetic Clinician B|Synthetic Client|2099-09-29T18:00:00.000Z": { patientId: "synthetic-patient-B", isIntake: true, isTelehealth: true },
  };

  const sent = realLedger.load(ledgerPath);
  const { migrateLegacyLedgerKeys } = require("../index");
  const migrated = migrateLegacyLedgerKeys(sent, cache, { key: realLedger.key, save: (s) => realLedger.save(s, ledgerPath) });
  assert.equal(migrated, true);

  const expectedNewKey = realLedger.key("Synthetic Client", start.toISOString(), stage);
  assert.ok(sent.has(expectedNewKey), "migration must add the new client-identity key");

  // The run's own dispatch check must now see it as already sent, with no
  // resend, even though this run's classify happened to read yet another
  // (fresh) patient id for the same appointment.
  const sends = [];
  const outcome = await dispatch("nag", {
    patientId: "synthetic-patient-C",
    client: "Synthetic Client",
    clinician: "Synthetic Clinician C",
    start,
    missing: ["SOD"],
  }, new Date("2099-09-29T03:35:00.000Z"), sent, { dryRun: false, test: false, force: false }, {
    sendEmail: async (msg) => sends.push(msg),
    ledger: { key: realLedger.key, save: (s) => realLedger.save(s, ledgerPath) },
  });

  assert.equal(outcome, "already-sent");
  assert.equal(sends.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});
