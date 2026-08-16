// Unit tests for the sentinel-v5 check-in helper (scripts/sentinel-v5/).
// Everything here uses a temp spool root and synthetic timestamps — no PHI,
// no TherapyNotes, no email.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { emitCheckin, captureInvocation, invocationNow, isB1Dark } from "../scripts/sentinel-v5/checkin.mjs";
import { slotForItem, isItemEnabled } from "../scripts/sentinel-v5/cron-slot.mjs";
import { SENTINEL_V5_REASON_CODES } from "../scripts/sentinel-v5/checkin-schema.mjs";
import { INTAKE_DOC_REMINDERS_ITEMS } from "../scripts/sentinel-v5/item-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ITEM = "idr-hourly-reminders";
const FRAGMENT_PATH = join(HERE, "..", "config", "sentinel-v5-registry-fragment.blt-intake-doc-reminders.json");

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "idr-sentinel-"));
}

test("registry fragment: one live, paging T1 row on the launchd cadence", () => {
  const fragment = JSON.parse(readFileSync(FRAGMENT_PATH, "utf8"));
  assert.equal(fragment.items.length, 1);
  const row = fragment.items[0];
  assert.equal(row.id, ITEM);
  assert.equal(row.repo, "blt-intake-doc-reminders");
  assert.equal(row.enabled, true);
  assert.equal(row.shadow, false);
  assert.equal(row.tier, "T1");
  // 14 slots a day, :35 past 07..20 Pacific — matches the launch agent's
  // StartCalendarInterval array (see test/mac-launchagent-install.test.js).
  assert.equal(row.schedule.cron, "35 7-20 * * *");
  assert.equal(row.schedule.tz, "America/Los_Angeles");
  assert.deepEqual(row.escalation, { page: "client_staff_facing_outage", deadline_minutes: 60, digest: true });
  for (const code of row.reason_codes) assert.ok(SENTINEL_V5_REASON_CODES.includes(code), `unknown reason code ${code}`);
  assert.deepEqual(Object.keys(INTAKE_DOC_REMINDERS_ITEMS), fragment.items.map((i) => i.id));
  assert.equal(isItemEnabled(ITEM), true);
});

test("slot capture: an invocation just after :35 Pacific claims that :35 slot", () => {
  // 2026-08-15 14:36 PDT == 21:36Z; slot is 14:35 PDT == 21:35Z.
  const inv = captureInvocation(ITEM, new Date("2026-08-15T21:36:00Z"));
  assert.equal(inv.at, "2026-08-15T21:36:00.000Z");
  assert.equal(inv.slot, "2026-08-15T21:35:00Z");
  // First and last slots of the day resolve too (07:35 and 20:35 PDT).
  assert.equal(slotForItem(ITEM, new Date("2026-08-15T14:40:00Z")), "2026-08-15T14:35:00Z");
  assert.equal(slotForItem(ITEM, new Date("2026-08-16T03:40:00Z")), "2026-08-16T03:35:00Z");
});

test("slot capture: a manual run outside the acceptance window resolves to no slot", () => {
  // 45 minutes after 14:35 PDT — past grace 30 + skew 5.
  assert.throws(() => captureInvocation(ITEM, new Date("2026-08-15T22:20:00Z")), /stale|acceptance window/);
  // Before the first slot of the day, the previous evening's 20:35 is far too old.
  assert.throws(() => captureInvocation(ITEM, new Date("2026-08-15T13:00:00Z")), /stale|acceptance window/);
});

test("invocationNow honors the test clock only when the spool root is overridden", () => {
  const withRoot = invocationNow({ SENTINEL_V5_TEST_NOW: "2026-08-15T21:36:00Z", SENTINEL_V5_SPOOL_ROOT: "/tmp/x" });
  assert.equal(withRoot.toISOString(), "2026-08-15T21:36:00.000Z");
  const withoutRoot = invocationNow({ SENTINEL_V5_TEST_NOW: "2026-08-15T21:36:00Z" });
  assert.ok(Math.abs(Date.now() - withoutRoot.getTime()) < 5000, "falls back to the real clock");
  assert.throws(() => invocationNow({ SENTINEL_V5_TEST_NOW: "garbage", SENTINEL_V5_SPOOL_ROOT: "/tmp/x" }), /invalid/);
});

test("emitCheckin lands a schema-v2 file in <root>/incoming for green, yellow and red", () => {
  const root = tmpRoot();
  try {
    const cases = [
      ["green", "ok"],
      ["yellow", "degraded"],
      ["red", "job_failed"],
    ];
    for (const [status, reasonCode] of cases) {
      const res = emitCheckin({
        item: ITEM, status, reasonCode,
        at: "2026-08-15T21:36:00Z", slot: "2026-08-15T21:35:00Z",
        spoolRoot: root, env: {},
      });
      assert.equal(res.admitted, true, `${status} admitted`);
      const payload = JSON.parse(readFileSync(join(root, "incoming", res.filename), "utf8"));
      assert.equal(payload.schema, 2);
      assert.equal(payload.item, ITEM);
      assert.equal(payload.repo, "blt-intake-doc-reminders");
      assert.equal(payload.status, status);
      assert.equal(payload.reason_code, reasonCode);
      assert.equal(payload.slot, "2026-08-15T21:35:00Z");
      assert.equal(payload.evidence_ref, `${ITEM}/${payload.run_id}`);
      assert.match(res.filename, new RegExp(`^${ITEM}__${ITEM}-\\d+-\\d+__[0-9a-f]{64}\\.json$`));
    }
    assert.equal(readdirSync(join(root, "incoming")).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitCheckin refuses unknown items and bad vocab, and stays inert under the B1 dark marker", () => {
  const root = tmpRoot();
  try {
    assert.throws(() => emitCheckin({ item: "not-a-real-item", status: "green", reasonCode: "ok", at: "2026-08-15T21:36:00Z", slot: "2026-08-15T21:35:00Z", spoolRoot: root, env: {} }), /unknown item/);
    assert.throws(() => emitCheckin({ item: ITEM, status: "purple", reasonCode: "ok", slot: "2026-08-15T21:35:00Z", spoolRoot: root, env: {} }), /invalid status/);
    assert.throws(() => emitCheckin({ item: ITEM, status: "red", reasonCode: "tn_login_failed", slot: "2026-08-15T21:35:00Z", spoolRoot: root, env: {} }), /invalid reason_code/);
    const marker = join(root, "b1-dark");
    writeFileSync(marker, "");
    assert.equal(isB1Dark({ SENTINEL_V5_B1_DARK_MARKER: marker }), true);
    const res = emitCheckin({ item: ITEM, status: "green", reasonCode: "ok", at: "2026-08-15T21:36:00Z", slot: "2026-08-15T21:35:00Z", spoolRoot: root, env: { SENTINEL_V5_B1_DARK_MARKER: marker } });
    assert.deepEqual(res, { filename: null, admitted: false, reason: "sentinel_v5_b1_dark" });
    assert.equal(readdirSync(root).includes("incoming"), false, "dark marker means no spool dirs are even created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
