// ledger.js — durable record of which emails have already gone out, so the
// hourly run is idempotent (re-running is a no-op unless --force). Stored at
// data/sent.json (gitignored — keys are a hash of the client's name, not the
// client's name or the TN patient id in the clear).
//
// Key shape: "<clientIdentityHash>@<apptStartISO>#<stage>", stage in {nag, escalation, confirm}.
// Entries for appointments more than PRUNE_DAYS in the past are dropped on save.
//
// Identity is derived from the client's own display name, NOT the TN patient
// id classifyAppointment() reads from the appointment's popup. That id is
// re-derived on every classify-cache miss, and a cache miss happens whenever
// the (clinician, client, apptStartISO) cache key changes -- including when
// TN simply relabels which clinician's column an appointment is filed under,
// a benign schedule edit that doesn't change the client or the appointment
// time. On 2026-09-28 that relabel produced a second, different patient id
// for the same client and the same appointment slot; keying dedupe on the
// patient id meant the "already sent" check never matched the earlier send,
// and the nag went out twice. The client's display name is stable across a
// clinician relabel, so it is what identifies "this intake occasion" here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_PATH = path.join(__dirname, '..', 'data', 'sent.json');
const PRUNE_DAYS = 3;

function load(ledgerPath = LEDGER_PATH) {
  try {
    const raw = fs.readFileSync(ledgerPath, 'utf8');
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

function save(set, ledgerPath = LEDGER_PATH) {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
  const kept = [...set].filter(k => {
    const t = apptStartMsFromKey(k);
    return Number.isNaN(t) || t >= cutoff;
  });
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const tmp = `${ledgerPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ sent: kept.sort() }, null, 2));
  fs.renameSync(tmp, ledgerPath);
}

// Normalized, hashed identity for a client display name. Hashed (not stored
// in the clear) so the ledger keeps the same opaque-identifier property a
// patient id had, without depending on a value classifyAppointment() can
// silently re-derive as something different for the same appointment.
function clientIdentity(client) {
  const normalized = String(client || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function key(client, apptStartISO, stage) {
  return `${clientIdentity(client)}@${apptStartISO}#${stage}`;
}

module.exports = { load, save, key, clientIdentity, LEDGER_PATH };
