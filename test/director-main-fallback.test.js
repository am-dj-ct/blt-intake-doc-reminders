'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('actual CLI finishes later escalation, confirmation, ledger, report and cleanup after first director handoff fails', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-director-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'lib'));
  for (const file of ['index.js', 'config.js', 'lib/ledger.js', 'lib/templates.js', 'lib/finish-run.js', 'lib/director-rollup.js']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  }
  fs.writeFileSync(path.join(root, 'preload.js'), `
    const Module = require('node:module'), fs = require('node:fs'), path = require('node:path');
    const original = Module._load, root = __dirname;
    const realRollup = require('./lib/director-rollup');
    let day, events = 0;
    const rows = [
      { client: 'Synthetic One', clinician: 'Brad Corcoran', time: '18:00', aria: '1', status: 'scheduled' },
      { client: 'Synthetic Two', clinician: 'Brad Corcoran', time: '10:00', aria: '2', status: 'scheduled' },
      { client: 'Synthetic Three', clinician: 'Brad Corcoran', time: '19:00', aria: '3', status: 'scheduled' }
    ];
    const broker = { withPreWorkAccountFailover: async fn => fn() };
    Module._load = function(request, parent, isMain) {
      if (parent?.filename === path.join(root, 'index.js')) {
        if (request === './lib/tn') return {
          ymd: d => d.toISOString().slice(0,10),
          parseApptStart: (d, time) => new Date(d + 'T' + time + ':00Z'),
          launch: async () => ({ page: {} }),
          gotoDay: async (_page, d) => { day = d; return { ok: true, coverageOk: true }; },
          scrapeDayGrid: async () => day === '2099-09-28' ? rows : [],
          classifyAppointment: async (_page, id) => ({ isIntake: true, isTelehealth: true, patientId: id }),
          getDocumentTitles: async (_page, id) => id === '3' ? ['complete'] : []
        };
        if (request === './lib/account-broker') return { loadBroker: () => broker };
        if (request === './lib/tn-account-session') return {
          isEnabled: () => true,
          resolveAccount: async () => ({ decision: { resolved: { account: 'synthetic' } } }),
          profileDirFor: () => path.join(root, 'profile'),
          acquireSession: async () => ({ ok: true, verifyStillOwner: () => ({ ok: true }) }),
          ensureLoginAndIdentity: async () => {},
          cleanupAndRelease: async () => { fs.writeFileSync(path.join(root, 'released'), 'yes'); return { confirmed: true }; }
        };
        if (request === './lib/classify') return { classifyDocs: async rows => ({ hasSOD: rows.length > 0, hasGAINSS: rows.length > 0 }) };
        if (request === './lib/send') return { sendEmail: async m => fs.appendFileSync(path.join(root, 'messages.jsonl'), JSON.stringify(m) + '\\n') };
        if (request === './lib/director-rollup') return { recordDirectorEvent: e => {
          if (++events === 1) throw new Error('synthetic disk error');
          return realRollup.recordDirectorEvent(e);
        } };
      }
      return original.call(this, request, parent, isMain);
    };
  `);
  const result = spawnSync(process.execPath, ['--require', path.join(root, 'preload.js'), path.join(root, 'index.js'), '--date', '2099-09-28', '--time', '09:00'], {
    env: { ...process.env, TZ: 'UTC', BLT_WEEKLY_DIRECTOR_ROOT: path.join(root, 'weekly') }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr || result.error?.message);
  assert.match(result.stderr, /all staff notices and reports completed/);
  const messages = fs.readFileSync(path.join(root, 'messages.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 3);
  assert.match(messages[0].subject, /^Intake docs needed/);
  assert.deepEqual(messages[0].cc, ['jesse@balancedlivingtherapy.com']);
  assert.match(messages[1].subject, /^STILL MISSING/);
  assert.deepEqual(messages[1].cc, ['jesse@balancedlivingtherapy.com']);
  assert.match(messages[2].subject, /^Intake docs received/);
  assert.equal(messages[2].to, 'brad@balancedlivingtherapy.com');
  assert.deepEqual(messages[2].cc, ['frontdesk@balancedlivingtherapy.com']);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data/sent.json'))).sent;
  assert.equal(ledger.filter(k => /#(nag|escalation|confirm)$/.test(k)).length, 3);
  assert.ok(ledger.some(k => k.endsWith('#digest')));
  assert.ok(fs.existsSync(path.join(root, 'data/digests/2099-09-28.html')));
  assert.ok(fs.existsSync(path.join(root, 'released')));
  const status = JSON.parse(fs.readFileSync(path.join(root, 'data/status/latest.json')));
  assert.equal(status.workCompleted, true);
  assert.equal(status.lockReleased, true);
  assert.equal(status.health, 'red');
  assert.equal(status.outcome, 'failed');
  assert.equal(status.directorHandoffFailureCount, 1);
});
