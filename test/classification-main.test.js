'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('isolated CLI persists service-day red and finishes digest decision and teardown before emitting wrapper red', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-classification-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'data/status'), { recursive: true });
  for (const file of ['index.js', 'config.js', 'lib/ledger.js', 'lib/templates.js', 'lib/finish-run.js', 'lib/director-rollup.js', 'lib/classification-state.js']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  }
  fs.writeFileSync(path.join(root, 'data/status/latest.json'), JSON.stringify({
    zeroIntakeStreakUnit: 'service_days',
    zeroIntakeCandidateDays: ['2099-09-21', '2099-09-22', '2099-09-23', '2099-09-24', '2099-09-25'],
    zeroIntakeCandidateStreak: 5,
  }));
  fs.writeFileSync(path.join(root, 'preload.js'), `
    const Module = require('node:module'), fs = require('node:fs'), path = require('node:path');
    const original = Module._load, root = __dirname;
    let day;
    Module._load = function(request, parent, isMain) {
      if (parent?.filename === path.join(root, 'index.js')) {
        if (request === './lib/tn') return {
          ymd: d => d.toISOString().slice(0,10),
          parseApptStart: (d, time) => new Date(d + 'T' + time + ':00Z'),
          launch: async () => ({ page: {} }),
          gotoDay: async (_page, d) => { day = d; return { ok: true, coverageOk: true }; },
          scrapeDayGrid: async () => day === '2099-09-28' ? [{ client: 'Synthetic', clinician: 'Synthetic', time: '18:00', aria: 'synthetic', status: 'scheduled' }] : [],
          classifyAppointment: async () => ({ isIntake: false })
        };
        if (request === './lib/account-broker') return { loadBroker: () => ({ withPreWorkAccountFailover: async fn => fn() }) };
        if (request === './lib/tn-account-session') return {
          isEnabled: () => true,
          resolveAccount: async () => ({ decision: { resolved: { account: 'synthetic' } } }),
          profileDirFor: () => path.join(root, 'profile'),
          acquireSession: async () => ({ ok: true, verifyStillOwner: () => ({ ok: true }) }),
          ensureLoginAndIdentity: async () => {},
          cleanupAndRelease: async () => { fs.writeFileSync(path.join(root, 'released'), 'yes'); return { confirmed: true }; }
        };
        if (request === './lib/classify' || request === './lib/send') return new Proxy({}, { get: () => () => { throw Error('network forbidden'); } });
      }
      return original.call(this, request, parent, isMain);
    };
  `);
  const result = spawnSync(process.execPath, ['--require', path.join(root, 'preload.js'), path.join(root, 'index.js'), '--date', '2099-09-28', '--time', '13:00', '--force'], {
    env: { ...process.env, TZ: 'UTC', BLT_INTAKE_DOC_REMINDERS_HEALTH_FILE: path.join(root, 'health') }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /6 distinct service day/);
  assert.match(result.stdout, /Done\. durationMs=\d+ lockReleased=true/);
  assert.equal(fs.readFileSync(path.join(root, 'health'), 'utf8').trim(), 'red');
  assert.ok(fs.existsSync(path.join(root, 'released')));
  assert.match(result.stdout, /\[digest\] skipped/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'data/sent.json'))).sent.some(key => key.endsWith('#digest')));
  const status = JSON.parse(fs.readFileSync(path.join(root, 'data/status/latest.json')));
  assert.equal(status.workCompleted, true);
  assert.equal(status.lockReleased, true);
  assert.equal(status.phase, 'finished');
  assert.equal(status.health, 'red');
  assert.equal(status.outcome, 'failed');
  assert.equal(status.alertCode, 'candidates_zero_intakes_streak');
  assert.equal(status.zeroIntakeCandidateStreak, 6);
  assert.equal(status.zeroIntakeStreakUnit, 'service_days');
});
