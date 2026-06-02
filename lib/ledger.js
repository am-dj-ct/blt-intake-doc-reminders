// ledger.js — durable record of which emails have already gone out, so the
// hourly run is idempotent (re-running is a no-op unless --force). Stored at
// data/sent.json (gitignored — keys contain patient ids).
//
// Key shape: "<patientId>@<apptStartISO>#<stage>", stage in {nag, escalation, confirm}.
// Entries for appointments more than PRUNE_DAYS in the past are dropped on save.

const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', 'data', 'sent.json');
const PRUNE_DAYS = 3;

function load() {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf8');
    return new Set(JSON.parse(raw).sent || []);
  } catch (e) {
    if (e.code === 'ENOENT') return new Set();
    throw e;
  }
}

function apptStartMsFromKey(k) {
  const m = /@([^#]+)#/.exec(k);
  return m ? Date.parse(m[1]) : NaN;
}

function save(set) {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
  const kept = [...set].filter(k => {
    const t = apptStartMsFromKey(k);
    return Number.isNaN(t) || t >= cutoff;
  });
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify({ sent: kept.sort() }, null, 2));
}

function key(patientId, apptStartISO, stage) {
  return `${patientId}@${apptStartISO}#${stage}`;
}

module.exports = { load, save, key, LEDGER_PATH };
