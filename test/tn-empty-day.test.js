"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { gotoDay } = require("../lib/tn");

function emptyDayPage({ calendarRendered = true } = {}) {
  const waitedFor = [];
  return {
    waitedFor,
    async goto() {},
    async waitForTimeout() {},
    async click() { throw new Error("Day tab already selected"); },
    async $$eval(selector) {
      assert.equal(selector, ".HeaderStrip.calendar-dayView-headerCell");
      return Array.from({ length: 22 }, (_, index) => `Clinician ${index + 1}`);
    },
    async waitForSelector(selector) {
      waitedFor.push(selector);
      if (!calendarRendered) throw new Error("calendar frame did not render");
      return {};
    },
  };
}

test("an empty day is healthy when the full calendar frame rendered", async () => {
  const page = emptyDayPage();
  const result = await gotoDay(page, "2026-08-15");

  assert.deepEqual(result, { ok: true, coverageOk: true });
  assert.deepEqual(page.waitedFor, [".calendar-weekview-dayColumn"]);
});

test("a missing calendar frame remains a failed day load", async () => {
  const page = emptyDayPage({ calendarRendered: false });
  const result = await gotoDay(page, "2026-08-15");

  assert.equal(result.ok, false);
  assert.equal(result.coverageOk, true);
  assert.match(result.error.message, /calendar frame did not render/);
});
