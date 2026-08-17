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
  WINDOW_HOURS, ESCALATION_HOURS, DIGEST_HOUR, DIGEST_TO, ALERT_TO,
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
      // One call, deliberately: login, identity, and releasing the intent
      // marker the login wrote. Running the first two and forgetting the
      // third is the defect this replaced -- it leaked a marker on every run
      // that performed a fresh password login, for nine days.
      await session.ensureLoginAndIdentity({ page: launched.page, broker, resolved, env, dopplerReader });

      let released = false;
      return {
        skip: false,
        page: launched.page,
        account: resolved.account,
        release: async () => {
          if (released) return;
          released = true;
          const cleanup = await session.cleanupAndRelease({ launched, profileDir, lockSession, broker });
          if (!cleanup.confirmed) {
            // Browser death and lock release are both confirmed — a graceful
            // context/browser close that timed out is cosmetic, so warn and let
            // the run finish cleanly instead of exiting non-zero over teardown
            // that actually succeeded.
            if (cleanup.safeToClose) { console.warn(`[cleanup] graceful browser close was imperfect but teardown is confirmed: ${cleanup.error?.message}`); return; }
            throw cleanup.error;
          }
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

// Decide whether the daily heartbeat digest can stay silent this run.
//
// Silence is allowed ONLY when the run can be trusted to have seen the whole
// picture — today and tomorrow were both scraped and every scraped day loaded
// cleanly (no failed load, no still-filtered clinician roster; both folded into
// `entry.ok`) — AND there is genuinely nothing to report: zero intakes TODAY.
//
// Keyed on TODAY's intakes only. The digest body only ever describes today, so
// an intake sitting tomorrow (even one with missing docs — that already fires
// its own nag/escalation email, cc'd to Jesse) must not force a send: doing so
// produced a "no virtual intakes today" email on every quiet day that happened
// to precede a busy one. A broken or filtered scrape still always sends —
// surfacing that is the heartbeat's whole job.
function digestSuppressible({ todayIntakeCount, gridByDay, todayYmd, tomorrowYmd }) {
  const plan = digestPlan({ todayIntakeCount, gridByDay, todayYmd, tomorrowYmd });
  return !plan.sendPhiDigest && !plan.sendScrapeAlert;
}

// Alert-mail reroute split (2026-08-16): the old single digest mixed two
// signals — "here is today's intake picture" (PHI: client names, -> jesse@,
// inside the BAA boundary) and "the scrape could not be trusted" (alert-class,
// no PHI, -> the sentinel mailbox). This decides each independently:
//   - PHI digest goes out iff there are intakes today to describe.
//   - Scrape alert goes out iff today+tomorrow were not both scraped clean.
// Both false is exactly the old suppression condition: a provably-quiet day.
function digestPlan({ todayIntakeCount, gridByDay, todayYmd, tomorrowYmd }) {
  const requiredDaysScraped = Boolean(gridByDay[todayYmd]) && Boolean(gridByDay[tomorrowYmd]);
  const everyScrapedDayClean = Object.keys(gridByDay)
    .every(ymd => Boolean(gridByDay[ymd] && gridByDay[ymd].ok));
  const scrapeTrustworthy = requiredDaysScraped && everyScrapedDayClean;
  return {
    sendPhiDigest: todayIntakeCount > 0,
    sendScrapeAlert: !scrapeTrustworthy,
  };
}

// Sentinel-v5 "degraded" side channel. run.sh exports
// BLT_INTAKE_DOC_REMINDERS_HEALTH_FILE and, after a clean exit, reads one word
// from it: "degraded" turns the check-in yellow (digest, not a page). The run
// is degraded when it finished but could not fully trust its own scrape —
// a day failed to load or the clinician view was still filtered. Zero
// intakes on a quiet day is NOT degraded; that is green by design (the
// digest is gated on today's intakes for exactly that reason).
function runHealthVerdict(gridByDay) {
  const unprovable = Object.values(gridByDay).some(day => !(day && day.ok));
  return unprovable ? 'degraded' : 'ok';
}
function reportRunHealth(verdict, env = process.env) {
  const file = env.BLT_INTAKE_DOC_REMINDERS_HEALTH_FILE;
  if (!file) return;
  try { fs.writeFileSync(file, `${verdict}\n`); }
  catch (e) { console.warn(`[sentinel] could not write health verdict (${e.message}) — non-fatal`); }
}

// The TN-account-busy skip exits 0 but did NO work: no schedule was checked
// and no reminder could go out. Report it as degraded (yellow, digest) so the
// sentinel never reads a skipped hour as a healthy green run; a run of
// consecutive busy hours becomes visible instead of silent.
function reportSkippedRun(session, env = process.env) {
  if (!session || !session.skip) return 'ok';
  reportRunHealth('degraded', env);
  return 'degraded';
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
    reportSkippedRun(session);
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
    reportRunHealth(runHealthVerdict(gridByDay));

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

      const plan = digestPlan({
        todayIntakeCount: today.length,
        gridByDay,
        todayYmd,
        tomorrowYmd,
      });

      if (!plan.sendPhiDigest && !plan.sendScrapeAlert) {
        console.log('[digest] skipped — no virtual intakes today, today+tomorrow scraped clean');
        if (!opts.dryRun) { sent.add(digestKey); ledger.save(sent); }
      } else {
        const dateLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const ranAt = now.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

        // Alert-class, no PHI -> sentinel mailbox. Sent first: if the PHI
        // digest send then fails, the next run retries both (digestKey is
        // only banked after every planned send succeeded), which can repeat
        // this alert — an acceptable duplicate for an alert-class signal.
        if (plan.sendScrapeAlert) {
          const alert = templates.scrapeAlert({
            ranAt, dateLabel,
            todayIntakeCount: today.length,
            days: Object.keys(gridByDay).sort().map(ymd => ({ ymd, ok: Boolean(gridByDay[ymd] && gridByDay[ymd].ok) })),
          });
          const alertTo = opts.test ? SENDER : ALERT_TO;
          const alertSubj = opts.test ? `[TEST] ${alert.subject}` : alert.subject;
          console.log(`\n[digest] ${opts.dryRun ? 'DRY' : 'send'} scrape alert -> ${alertTo}: ${alertSubj}`);
          if (!opts.dryRun) { await sendEmail({ to: alertTo, cc: [], subject: alertSubj, html: alert.html }); console.log('  scrape alert sent.'); }
        }

        // PHI digest (client names + doc ticks) -> jesse@, inside the BAA
        // boundary. Only when there are intakes today to describe.
        if (plan.sendPhiDigest) {
          const { subject, html } = templates.digest({
            ranAt,
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
          if (!opts.dryRun) { await sendEmail({ to, cc: [], subject: subj, html }); console.log('  digest sent.'); }
        }

        if (!opts.dryRun) { sent.add(digestKey); ledger.save(sent); }
      }
    }
  } finally {
    await session.release();
  }
  console.log('\nDone.');
}

module.exports = { openTnSession, digestSuppressible, digestPlan, runHealthVerdict, reportRunHealth, reportSkippedRun };

// Print an error, then recurse into anything it bundles: AggregateError.errors
// (cleanup collects several failures into one) and .cause chains. Without this
// an "AggregateError: cleanup completed with errors." prints with no sign of
// which step actually failed.
function printErrorTree(err, seen = new Set(), depth = 0) {
  if (!err || seen.has(err)) return;
  seen.add(err);
  const pad = '  '.repeat(depth);
  console.error(`${pad}${err.stack || err}`);
  if (Array.isArray(err.errors)) {
    err.errors.forEach((sub, i) => { console.error(`${pad}[sub-error ${i}]`); printErrorTree(sub, seen, depth + 1); });
  }
  if (err.cause) { console.error(`${pad}[cause]`); printErrorTree(err.cause, seen, depth + 1); }
}

if (require.main === module) {
  main().catch(err => { console.error('FAILED:', err.message); printErrorTree(err); process.exit(1); });
}
