#!/usr/bin/env node
// check-docs.js — validate getDocumentTitles + the Azure classifier on one
// chart. Output is count-only and never prints document rows or identifiers.
//
//   doppler run -p agent-secrets -c dev -- node scripts/check-docs.js <patientId>

const tn = require('../lib/tn');
const { openTnSession } = require('../index');
const { classifyDocs } = require('../lib/classify');

(async () => {
  const patientId = process.argv[2];
  if (!patientId) { console.error('usage: check-docs.js <patientId>'); process.exit(1); }
  const session = await openTnSession({ headful: false });
  if (session.skip) { console.log(`TN account busy (${session.reason || 'busy'}); stopping.`); return; }
  const page = session.page;
  try {
    const rows = await tn.getDocumentTitles(page, patientId);
    const result = await classifyDocs(rows);
    console.log(JSON.stringify({ rowCount: rows.length, hasSOD: result.hasSOD, hasGAINSS: result.hasGAINSS }));
  } catch (e) {
    console.error('check-docs error:', e.message);
    process.exitCode = 1;
  } finally {
    await session.release();
  }
})();
