"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { dispatch, saveSentKey } = require("../index");

test("test-mode reminder and digest sends leave the live ledger unchanged", async () => {
  const sent = new Set(["existing-key"]);
  const sends = [];
  let saves = 0;
  const fakeLedger = {
    key: (patientId, start, stage) => `${patientId}@${start}#${stage}`,
    save: () => { saves += 1; },
  };
  const opts = { dryRun: false, test: true, force: false };
  const intake = {
    patientId: "synthetic-patient",
    client: "Client A",
    clinician: "Dr Test",
    start: new Date("2026-09-26T18:00:00.000Z"),
    missing: ["SOD"],
  };

  const outcome = await dispatch("nag", intake, new Date("2026-09-26T16:00:00.000Z"), sent, opts, {
    sendEmail: async message => sends.push(message),
    ledger: fakeLedger,
  });
  saveSentKey(sent, "digest@2026-09-26T12:00:00.000Z#digest", opts, fakeLedger);

  assert.equal(outcome, "sent");
  assert.equal(sends.length, 1);
  assert.match(sends[0].subject, /^\[TEST\] /);
  assert.deepEqual([...sent], ["existing-key"]);
  assert.equal(saves, 0);
});
