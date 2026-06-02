#!/usr/bin/env node
// check-docs.js — validate getDocumentTitles + the Azure classifier on one
// chart. PHI: the doc rows contain doc types, clinician (staff) names, and
// statuses — not the patient's name — so they're safe to print.
//
//   doppler run -p agent-secrets -c dev -- node scripts/check-docs.js <patientId>

const tn = require('../lib/tn');
const { classifyDocs } = require('../lib/classify');

(async () => {
  const patientId = process.argv[2];
  if (!patientId) { console.error('usage: check-docs.js <patientId>'); process.exit(1); }
  const { browser, page } = await tn.launch({ headless: true });
  try {
    await tn.login(page);
    const rows = await tn.getDocumentTitles(page, patientId);
    console.log(`document rows (${rows.length}):`);
    for (const r of rows) console.log('   -', r);
    console.log('\nclassifying via Azure OpenAI…');
    const result = await classifyDocs(rows);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('check-docs error:', e.message);
    console.error(e.stack);
  } finally {
    await browser.close();
  }
})();
