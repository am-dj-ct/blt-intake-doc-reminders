#!/usr/bin/env node
// index.js — hourly TherapyNotes intake-doc reminder.
//
// Each run:
//   1. Scrape today + tomorrow's schedule (all clinicians).
//   2. Keep scheduled VIDEO appointments in the next WINDOW_HOURS.
//   3. Classify each (popup: CPT 90791 + Telehealth checkbox + patient id),
//      cached so repeat runs don't re-open popups.
//   4. For each virtual intake, read the chart's Documents and ask Azure OpenAI
//      whether the SOD and GAINSS are present.
//   5. State machine, one email max per (patient+appt+stage) via the ledger:
//        - nag        : docs missing, > ESCALATION_HOURS before start  -> frontdesk@
//        - escalation : docs missing, within ESCALATION_HOURS of start -> frontdesk@, cc jesse@
//        - confirm    : both docs present                              -> therapist, cc frontdesk@
//
// CLI:
//   doppler run -p agent-secrets -c dev -- node index.js [--dry-run] [--test]
//                                                        [--date YYYY-MM-DD] [--time HH:MM]
//                                                        [--force] [--headful]
//   --dry-run  scrape + classify + decide, print actions, send nothing, don't touch ledger
//   --test     route every email to jesse@ only (subject prefixed [TEST])
//   --date/--time  override "now" for testing
//   --force    ignore the ledger (re-send)

const fs = require('fs');
const path = require('path');
const tn = require('./lib/tn');
const { classifyDocs } = require('./lib/classify');
const { sendEmail } = require('./lib/send');
const templates = require('./lib/templates');
const ledger = require('./lib/ledger');
const {
  SENDER, FRONTDESK, ALWAYS_CC, CLINICIAN_EMAILS,
  WINDOW_HOURS, ESCALATION_HOURS, DIGEST_HOUR, DIGEST_TO,
} = require('./config');

const CACHE_PATH = path.join(__dirname, 'data', 'appts.json');
const HOUR = 3600 * 1000;

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { dryRun: false, test: false, force: false, headful: false, date: null, time: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--dry-run') o.dryRun = true;
    else if (a[i] === '--test') o.test = true;
    else if (a[i] === '--force') o.force = true;
    else if (a[i] === '--headful') o.headful = true;
    else if (a[i] === '--date') o.date = a[++i];
    else if (a[i] === '--time') o.time = a[++i];
    else { console.error(`unknown arg: ${a[i]}`); process.exit(2); }
  }
  return o;
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function saveCache(obj, now) {
  const cutoff = now.getTime() - 2 * 24 * HOUR;
  const kept = {};
  for (const [k, v] of Object.entries(obj)) {
    const m = /\|([^|]+)$/.exec(k);
    const t = m ? Date.parse(m[1]) : NaN;
    if (Number.isNaN(t) || t >= cutoff) kept[k] = v;
  }
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(kept, null, 2));
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function sameYmd(a, b) { return tn.ymd(a) === tn.ymd(b); }

function humanAppt(start, now) {
  const time = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameYmd(start, now)) return `today at ${time}`;
  const tomorrow = new Date(now.getTime() + 24 * HOUR);
  if (sameYmd(start, tomorrow)) return `tomorrow at ${time}`;
  return `${start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}

async function dispatch(stage, it, now, sent, opts) {
  const apptISO = it.start.toISOString();
  const k = ledger.key(it.patientId, apptISO, stage);
  if (sent.has(k) && !opts.force) { console.log(`  [skip] ${stage} — already sent for ${it.client}`); return; }

  const apptHuman = humanAppt(it.start, now);
  const hoursLeft = Math.max(1, Math.round((it.start - now) / HOUR));
  let to, cc = [], msg;
  if (stage === 'nag') {
    to = FRONTDESK;
    msg = templates.nag({ client: it.client, clinicianName: it.clinician, apptHuman, missing: it.missing });
  } else if (stage === 'escalation') {
    to = FRONTDESK;
    msg = templates.escalation({ client: it.client, clinicianName: it.clinician, apptHuman, missing: it.missing, hoursLeft });
  } else { // confirm
    const tEmail = CLINICIAN_EMAILS[it.clinician];
    if (!tEmail) { console.log(`  [warn] no email mapped for clinician "${it.clinician}" — skipping confirm for ${it.client}`); return; }
    to = tEmail; cc = [FRONTDESK];
    msg = templates.confirm({ client: it.client, clinicianName: it.clinician, apptHuman });
  }

  // jesse@ on every email; dedupe and never cc the primary recipient.
  cc = [...new Set([...cc, ...ALWAYS_CC])].filter(a => a !== to);

  let { subject } = msg;
  if (opts.test) { to = SENDER; cc = []; subject = `[TEST] ${subject}`; }

  console.log(`  [${opts.dryRun ? 'DRY' : 'SEND'}] ${stage}: ${it.client} (${apptHuman}) -> ${to}${cc.length ? ` cc ${cc.join(',')}` : ''}`);
  console.log(`          subject: ${subject}`);
  if (opts.dryRun) return;

  await sendEmail({ to, cc, subject, html: msg.html });
  sent.add(k);
  ledger.save(sent);
  console.log(`          sent.`);
}

async function main() {
  const opts = parseArgs();
  const now = opts.date ? new Date(`${opts.date}T${opts.time || '09:00'}:00`) : new Date();
  const windowEnd = new Date(now.getTime() + WINDOW_HOURS * HOUR);
  console.log(`=== BLT intake-doc reminder — now=${now.toISOString()} window=${WINDOW_HOURS}h ${opts.dryRun ? '[dry-run]' : ''}${opts.test ? '[test]' : ''} ===`);

  // Dates spanning the window.
  const dates = [];
  for (let t = startOfDay(now).getTime(); t <= windowEnd.getTime(); t += 24 * HOUR) dates.push(tn.ymd(new Date(t)));

  const { browser, page } = await tn.launch({ headless: !opts.headful });
  const cache = loadCache();
  const intakes = [];
  try {
    await tn.login(page);

    // Phase A: per day, scrape grid, classify in-window video candidates (popup, cached).
    for (const d of dates) {
      await tn.gotoDay(page, d);
      const grid = await tn.scrapeDayGrid(page);
      const candidates = grid
        .map(a => ({ ...a, date: d, start: tn.parseApptStart(d, a.time) }))
        .filter(a => a.start && a.status === 'scheduled' && a.modality === 'video' && a.start > now && a.start <= windowEnd);
      console.log(`${d}: ${grid.length} appts, ${candidates.length} in-window video candidate(s)`);

      for (const a of candidates) {
        const key = `${a.clinician}|${a.client}|${a.start.toISOString()}`;
        let cls = cache[key];
        if (!cls) {
          cls = await tn.classifyAppointment(page, a.aria);
          if (cls) cache[key] = cls;
        }
        if (cls && cls.isIntake && cls.isTelehealth && cls.patientId) {
          intakes.push({ clinician: a.clinician, client: a.client, start: a.start, patientId: cls.patientId });
        }
      }
    }
    saveCache(cache, now);
    console.log(`\nVirtual intakes in window: ${intakes.length}`);

    // Phase B: per intake, read documents, classify, run the state machine.
    const sent = ledger.load();
    const results = [];
    for (const it of intakes) {
      const rows = await tn.getDocumentTitles(page, it.patientId);
      const { hasSOD, hasGAINSS } = await classifyDocs(rows);
      results.push({ client: it.client, clinician: it.clinician, start: it.start, hasSOD, hasGAINSS });
      const missing = [];
      if (!hasSOD) missing.push('SOD');
      if (!hasGAINSS) missing.push('GAINSS');
      const hoursToStart = (it.start - now) / HOUR;
      console.log(`\n${it.client} — ${it.clinician} — ${humanAppt(it.start, now)} (${hoursToStart.toFixed(1)}h) | docs: ${missing.length ? 'missing ' + missing.join('+') : 'all present'}`);

      if (missing.length === 0) {
        await dispatch('confirm', it, now, sent, opts);
      } else if (hoursToStart <= ESCALATION_HOURS) {
        await dispatch('escalation', { ...it, missing }, now, sent, opts);
      } else {
        await dispatch('nag', { ...it, missing }, now, sent, opts);
      }
    }

    // Daily digest / heartbeat — once per day, first run at/after DIGEST_HOUR.
    const digestKey = `digest@${tn.ymd(now)}T12:00:00.000Z#digest`;
    if (now.getHours() >= DIGEST_HOUR && (opts.force || !sent.has(digestKey))) {
      const todayYmd = tn.ymd(now);
      const today = results.filter(r => tn.ymd(r.start) === todayYmd).sort((a, b) => a.start - b.start);
      const dateLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      const { subject, html } = templates.digest({
        ranAt: now.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        dateLabel,
        intakes: today.map(r => ({
          time: r.start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          client: r.client, clinician: r.clinician, hasSOD: r.hasSOD, hasGAINSS: r.hasGAINSS,
        })),
      });
      const to = opts.test ? SENDER : DIGEST_TO;
      const subj = opts.test ? `[TEST] ${subject}` : subject;
      console.log(`\n[digest] ${opts.dryRun ? 'DRY' : 'send'} -> ${to}: ${subj}`);
      for (const i of today) console.log(`   ${i.start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} ${i.client} (${i.clinician}) SOD ${i.hasSOD ? 'Y' : 'N'} GAINSS ${i.hasGAINSS ? 'Y' : 'N'}`);
      if (!opts.dryRun) { await sendEmail({ to, cc: [], subject: subj, html }); sent.add(digestKey); ledger.save(sent); console.log('  digest sent.'); }
    }
  } finally {
    await browser.close();
  }
  console.log('\nDone.');
}

main().catch(err => { console.error('FAILED:', err.message); console.error(err.stack); process.exit(1); });
