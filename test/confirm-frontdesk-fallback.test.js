"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { FRONTDESK, ALWAYS_CC } = require("../config");
const { dispatch } = require("../index");

test("confirmation falls back to front desk when the therapist has no email", async () => {
  const sent = new Set();
  const messages = [];
  let saves = 0;
  const fakeLedger = {
    key: (patientId, start, stage) => `${patientId}@${start}#${stage}`,
    save: () => { saves += 1; },
  };
  const intake = {
    patientId: "synthetic-patient",
    client: "Client A",
    clinician: "Dr Test",
    start: new Date("2026-09-26T18:00:00.000Z"),
  };

  const outcome = await dispatch("confirm", intake, new Date("2026-09-26T16:00:00.000Z"), sent, {
    dryRun: false,
    test: false,
    force: false,
  }, {
    sendEmail: async message => messages.push(message),
    ledger: fakeLedger,
  });

  assert.equal(outcome, "sent");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, FRONTDESK);
  assert.deepEqual(messages[0].cc, ALWAYS_CC.filter(address => address !== FRONTDESK));
  assert.match(messages[0].html, /No therapist email is on file for "Dr Test", so front desk should forward this confirmation\./);
  assert.equal(sent.size, 1);
  assert.equal(saves, 1);
});
