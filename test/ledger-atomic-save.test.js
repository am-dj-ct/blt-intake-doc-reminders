"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ledger = require("../lib/ledger");

test("ledger save replaces its destination through a same-directory temp file", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = path.join(dir, "state", "sent.json");
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, "synthetic previous contents");

  const futureKey = ledger.key("synthetic-patient", "2099-09-26T18:00:00.000Z", "nag");
  ledger.save(new Set([futureKey]), ledgerPath);

  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerPath, "utf8")), { sent: [futureKey] });
  assert.equal(fs.existsSync(`${ledgerPath}.tmp-${process.pid}`), false);
});
