// The daily digest is split: PHI detail goes to a local report file, the
// email is a no-PHI status to the sentinel mailbox. These tests pin the
// safety property — no client data in the status mail — using synthetic data.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const templates = require('../lib/templates');
const { writeReportAtomically } = require('../index');
const { DIGEST_TO } = require('../config');

const FAKE = [
  { time: '9:00 AM', client: 'Test Clientname', clinician: 'Fake Clinician', hasSOD: true, hasGAINSS: false },
  { time: '1:00 PM', client: 'Another Fakeperson', clinician: 'Fake Clinician', hasSOD: false, hasGAINSS: false },
];

test('status mail carries counts only — no client names, times, or clinicians', () => {
  const { subject, html } = templates.digestStatus({
    ranAt: 'Mon, Aug 17, 8:35 AM', dateLabel: 'Monday, Aug 17',
    total: 2, docsComplete: 0, missingSOD: 1, missingGAINSS: 2,
    scrapeHealth: 'ok', reportPath: '/tmp/x/2026-08-17.html',
  });
  const all = subject + html;
  for (const bad of ['Test Clientname', 'Another Fakeperson', 'Fake Clinician', '9:00', '1:00']) {
    assert.ok(!all.includes(bad), `status mail must not contain ${bad}`);
  }
  assert.match(html, /intakes_today=2/);
  assert.match(html, /missing_sod=1/);
  assert.match(html, /missing_gainss=2/);
});

test('the digest recipient is the sentinel mailbox, not a human inbox', () => {
  assert.strictEqual(DIGEST_TO, 'sentinel@balancedlivingtherapy.com');
});

test('the PHI detail lives in the local report, written via temp+rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idr-digest-'));
  const dest = path.join(dir, 'digests', '2026-08-17.html');
  const html = templates.digestReport({ ranAt: 'x', dateLabel: 'y', intakes: FAKE });
  writeReportAtomically(dest, html);
  const onDisk = fs.readFileSync(dest, 'utf8');
  assert.ok(onDisk.includes('Test Clientname'));
  assert.strictEqual(fs.readdirSync(path.dirname(dest)).length, 1, 'no temp file left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});
