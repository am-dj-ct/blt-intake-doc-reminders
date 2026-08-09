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
const { loadBroker } = require('./lib/account-broker');
const tnAccountSession = require('./lib/tn-account-session');
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

// Open a TN session through the exact reviewed broker. A confirmed rejection
// from a fresh password submission may select the other standard account one
// time, but only after this exact browser is dead and this exact lock release
// is confirmed. Busy, cleanup, identity, and all post-open work never retry.
async function openTnSession(opts = {}, deps = {}) {
  const env = deps.env || process.env;
  const tnLib = deps.tn || tn;
  const session = deps.tnAccountSession || tnAccountSession;
  session.isEnabled(env);
  const broker = deps.broker || loadBroker(env);
  return broker.withPreWorkAccountFailover(async () => {
    const { decision, dopplerReader } = await session.resolveAccount({ env, broker });
    const resolved = decision.resolved;
    const profileDir = session.profileDirFor(resolved.account);
    const lockSession = await session.acquireSession({
      account: resolved.account,
      broker,
      env,
      browserProfileDir: profileDir,
    });
    if (!lockSession.ok) return { skip: true, reason: lockSession.reason };

    let launched;
    try {
      const ownerCheck = lockSession.verifyStillOwner();
      if (!ownerCheck.ok) {
        throw new Error(`TN account lock ownership lost before browser launch (${ownerCheck.reason}).`);
      }
      session.securePathTree(profileDir, { lockOwnershipVerified: true });
      launched = await tnLib.launch({ headless: !opts.headful, profileDir });
      await session.ensureLogin({ page: launched.page, broker, resolved, env, dopplerReader });
      await session.assertIdentityOrThrow({ page: launched.page, broker, resolved });

      let released = false;
      return {
        skip: false,
        page: launched.page,
        account: resolved.account,
        release: async () => {
          if (released) return;
          released = true;
          const cleanup = await session.cleanupAndRelease({ launched, profileDir, lockSession, broker });
          if (!cleanup.confirmed) throw cleanup.error;
        },
      };
    } catch (error) {
      const cleanup = await session.cleanupAndRelease({ launched, profileDir, lockSession, broker });
      if (cleanup.confirmed && session.retryableFreshLoginRejection(error)) {
        broker.confirmPreWorkFailoverCleanup(error, resolved.account);
      }
      if (!cleanup.confirmed) {
        throw new AggregateError([error, cleanup.error], "TherapyNotes pre-work failure and cleanup both failed.", { cause: error });
      }
      throw error;
    }
  });
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
// Calendar-day arithmetic, not fixed-ms — safe across DST transitions.
function addLocalDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 0, 0, 0, 0); }
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

  // Dates spanning the window. Stepped as calendar days (addLocalDays), not
  // fixed 24h of milliseconds — a fixed-ms step can land twice on the same
  // calendar date (or skip one) on a DST transition day, and the digest gate
  // now depends on `dates` covering both today and tomorrow.
  const dates = [];
  for (let i = 0; ; i++) {
    const day = addLocalDays(startOfDay(now), i);
    if (day.getTime() > windowEnd.getTime()) break;
    dates.push(tn.ymd(day));
  }

  const session = await openTnSession(opts);
  if (session.skip) {
    console.log(`\n[skip] TN account busy (skip-if-busy lock, reason=${session.reason || 'busy'}) — skipping this run cleanly; will retry next hourly pass.`);
    console.log('\nDone.');
    return;
  }
  const page = session.page;
  const cache = loadCache();
  const intakes = [];
  // Full, unfiltered per-calendar-day scrape results (today + tomorrow), kept
  // alongside the in-window `intakes` used for dispatch. The digest gate needs
  // this because the 30h dispatch window can clip late-tomorrow or
  // already-started-today appointments out of `intakes` — those aren't proof
  // the day is empty, just proof they're outside the nag/escalation window.
  const gridByDay = {};
  try {
    // Phase A: per day, scrape grid, classify in-window video candidates (popup, cached).
    for (const d of dates) {
      const dayLoad = await tn.gotoDay(page, d);
      const grid = await tn.scrapeDayGrid(page);
      // A load failure (dayLoad.ok === false), a still-filtered clinician
      // view (dayLoad.coverageOk === false), and a genuinely empty day all
      // scrape to []. Record both signals per day so the digest gate can
      // tell a real empty day from one it just couldn't fully check.
      const dayOk = !(dayLoad && dayLoad.ok === false);
      const coverageOk = !(dayLoad && dayLoad.coverageOk === false);
      gridByDay[d] = { grid, ok: dayOk && coverageOk };
      if (!dayOk) console.log(`${d}: day load failed (${dayLoad.error && dayLoad.error.message || 'unknown error'}) — digest gate will treat this day as unprovable`);
      else if (!coverageOk) console.log(`${d}: clinician view may still be filtered (coverage check failed) — digest gate will treat this day as unprovable`);
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
      const tomorrowYmd = tn.ymd(addLocalDays(now, 1));
      const today = results.filter(r => tn.ymd(r.start) === todayYmd).sort((a, b) => a.start - b.start);

      // Affirmative-empty proof, not "the in-window counts happen to be zero":
      // a full calendar day with zero scheduled/video appointments at all
      // cannot contain an intake, so it's provably empty. A day is
      // unprovable (forces send, never skip) when:
      //   - it was never scraped this run (missing from gridByDay)
      //   - its load failed (gotoDay's `ok: false`) — an empty scrape from a
      //     failed load is not proof of an empty schedule
      //   - its clinician view may still be filtered (`coverageOk: false`,
      //     folded into `entry.ok` below) — an empty scrape from a partial
      //     roster isn't proof either
      //   - it has a scheduled appointment with unknown/undetermined
      //     modality — can't rule that out as a virtual appointment
      const dayVideoCount = (ymd) => {
        const entry = gridByDay[ymd];
        if (!entry || !entry.ok) return null;
        const scheduled = entry.grid.filter(a => a.status === 'scheduled');
        if (scheduled.some(a => a.modality == null || a.modality === '')) return null;
        return scheduled.filter(a => a.modality === 'video').length;
      };

      // Check EVERY day actually scraped this run, not just today/tomorrow.
      // A late run's 30h window can leave a sliver of the day after tomorrow
      // in gridByDay (e.g. a ~19:00 run scrapes up to ~01:00 the day after
      // next) — an ambiguous or non-empty appointment sitting in that sliver
      // is just as real as one on today or tomorrow, and a two-day-only
      // check would miss it entirely. today/tomorrow are still required to
      // both have been scraped at all (a run that somehow skipped one of
      // them can't claim to have proven anything).
      const requiredDaysScraped = Boolean(gridByDay[todayYmd]) && Boolean(gridByDay[tomorrowYmd]);
      const everyScrapedDayEmpty = requiredDaysScraped &&
        Object.keys(gridByDay).every(ymd => dayVideoCount(ymd) === 0);

      // Missing docs, checked across the FULL scraped window, not just
      // today/tomorrow. Every candidate the scrape finds anywhere in the
      // window — including a day-after-tomorrow sliver — is already
      // classified into `results`. A missing-doc candidate there is real and
      // must not be missed just because it falls outside today/tomorrow.
      const missingAnywhereInWindow = results.some(r => !r.hasSOD || !r.hasGAINSS);

      const provablyEmpty = everyScrapedDayEmpty && !missingAnywhereInWindow;

      if (provablyEmpty) {
        console.log('[digest] skipped — nothing to report (0 intakes today, 0 tomorrow, 0 missing)');
        if (!opts.dryRun) { sent.add(digestKey); ledger.save(sent); }
      } else {
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
    }
  } finally {
    await session.release();
  }
  console.log('\nDone.');
}

module.exports = { openTnSession };

if (require.main === module) {
  main().catch(err => { console.error('FAILED:', err.message); console.error(err.stack); process.exit(1); });
}
