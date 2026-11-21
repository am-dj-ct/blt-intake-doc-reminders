const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordDirectorEvent } = require('../lib/director-rollup');
const { dispatch } = require('../index');
const { SENDER, FRONTDESK } = require('../config');
const now = new Date('2026-11-20T18:00:00Z');
const intake = { client: 'Synthetic Client', clinician: 'Jesse Dunn', start: new Date('2026-11-20T20:00:00Z'), missing: ['SOD'] };
function deps(send, write) { return { sendEmail: send, recordDirectorEvent: write, ledger: { key: (...v) => v.join('|'), save: () => {} } }; }
test('immutable count-only event is durable, private and idempotent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-rollup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  recordDirectorEvent({ key: 'synthetic-client-identity', stage: 'nag', now, root });
  recordDirectorEvent({ key: 'synthetic-client-identity', stage: 'nag', now: new Date('2026-11-21T18:00:00Z'), root });
  const names = fs.readdirSync(path.join(root, 'intake'));
  assert.equal(names.length, 1);
  const file = path.join(root, 'intake', names[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { version: 1, source: 'intake', stage: 'nag', occurredAt: now.toISOString() });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{}');
  assert.throws(() => recordDirectorEvent({ key: 'synthetic-client-identity', stage: 'nag', now, root }), /invalid/);
});
test('routine CC moves to durable digest; escalation and treating-clinician mail remain', async () => {
  const sends = [], events = [];
  for (const stage of ['nag', 'escalation', 'confirm']) {
    await dispatch(stage, intake, now, new Set(), {}, deps(async m => sends.push(m), e => events.push(e.stage)));
  }
  assert.deepEqual(events, ['nag']);
  assert.equal(sends[0].to, FRONTDESK); assert.deepEqual(sends[0].cc, []);
  assert.deepEqual(sends[1].cc, [SENDER]);
  assert.equal(sends[2].to, SENDER); assert.deepEqual(sends[2].cc, [FRONTDESK]);
});
test('handoff failure retains original director CC, commits sent key and fails loudly', async () => {
  const sends = [], sent = new Set();
  await assert.rejects(dispatch('nag', intake, now, sent, {}, deps(async m => sends.push(m), () => { throw new Error('disk unavailable'); })), /original director copy retained/);
  assert.equal(sends.length, 1); assert.deepEqual(sends[0].cc, [SENDER]); assert.equal(sent.size, 1);
});
test('dry and test paths never write live digest events', async () => {
  for (const opts of [{ dryRun: true }, { test: true }]) await dispatch('nag', intake, now, new Set(), opts, deps(async () => {}, () => assert.fail('live event write')));
});
