"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { getDocumentTitles, TN_PATIENTS_EDIT_URL } = require("../lib/tn");

test("document lookup waits for a table or explicit empty state and falls through on timeout", async () => {
  for (const waitError of [null, new Error("synthetic timeout")]) {
    const calls = [];
    const page = {
      goto: async (url, options) => calls.push(["goto", url, options]),
      waitForTimeout: async ms => calls.push(["pause", ms]),
      waitForFunction: async (predicate, argument, options) => {
        calls.push(["wait", String(predicate), argument, options]);
        if (waitError) throw waitError;
      },
      evaluate: async () => {
        calls.push(["evaluate"]);
        return ["Synthetic SOD 2026-09-26"];
      },
    };

    const rows = await getDocumentTitles(page, "syntheticPatient");
    assert.deepEqual(rows, ["Synthetic SOD 2026-09-26"]);
    assert.deepEqual(calls[0], ["goto", `${TN_PATIENTS_EDIT_URL}syntheticPatient/#tab=Documents`, { waitUntil: "domcontentloaded" }]);
    assert.deepEqual(calls[1], ["pause", 3500]);
    assert.equal(calls[2][0], "wait");
    assert.match(calls[2][1], /Notes and Documents for this Patient/);
    assert.match(calls[2][1], /querySelectorAll\('table'\)/);
    assert.equal(calls[2][2], undefined);
    assert.deepEqual(calls[2][3], { timeout: 20000 });
    assert.deepEqual(calls[3], ["evaluate"]);
  }
});
