#!/usr/bin/env node
'use strict';
const { readFileSync } = require('node:fs');
const { credential } = require('../lib/job-credentials.cjs');
async function sendWatchAlert(payload, fetcher = globalThis.fetch) {
  const key = credential('RESEND_API_KEY', 'Resend - BLT');
  if (!key) throw new Error('ALERT_CREDENTIAL_MISSING');
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('ALERT_HTTP_ERROR');
}
if (require.main === module) {
  Promise.resolve().then(() => sendWatchAlert(JSON.parse(readFileSync(process.argv[2], 'utf8'))))
    .catch(() => { process.exitCode = 1; });
}
module.exports = { sendWatchAlert };
