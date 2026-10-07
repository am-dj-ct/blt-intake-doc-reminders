// The daily digest report stays local: PHI detail goes to a report file inside
// the protected boundary and is never emailed. The no-PHI daily status email to
// the sentinel@ mailbox was removed 2026-10-07 (nobody read it; the job's one
// watcher emails jesse@ on failure). Synthetic data only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const templates = require('../lib/templates');
const config = require('../config');
const { writeReportAtomically } = require('../index');

const ROOT = path.join(__dirname, '..');

const FAKE = [
  { time: '9:00 AM', client: 'Test Clientname', clinician: 'Fake Clinician', hasSOD: true, hasGAINSS: false },
  { time: '1:00 PM', client: 'Another Fakeperson', clinician: 'Fake Clinician', hasSOD: false, hasGAINSS: false },
];

test('the daily status email is gone: no template, no recipient, no sentinel@ address in code', () => {
  assert.strictEqual(templates.digestStatus, undefined);
  assert.strictEqual(config.DIGEST_TO, undefined);
  for (const rel of ['index.js', 'config.js', 'lib/templates.js', 'lib/send.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/sentinel@/i.test(src.replace(/^\s*\/\/.*$/gm, '')), `${rel} must not address sentinel@ in code`);
  }
});

test('the digest block in main() writes the local report and sends no mail', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const start = src.indexOf('// Daily digest');
  const end = src.indexOf('runStatus = {', start);
  assert.ok(start > 0 && end > start, 'digest block found');
  const block = src.slice(start, end);
  assert.ok(!/sendEmail|send\(/.test(block), 'digest block must not send mail');
  assert.match(block, /writeReportAtomically\(reportPath, reportHtml\)/);
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
