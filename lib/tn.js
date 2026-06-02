// tn.js — TherapyNotes automation: login, day-view schedule scrape, appointment
// popup classification (intake? telehealth? which patient?), and patient
// Documents-tab inspection. Built on Playwright + the installed system Chrome.
//
// Login + grid-scrape logic ported from therapy-hours/lib/schedule.js (proven
// against BLT's live calendar). The popup + Documents selectors are confirmed
// against the live DOM via scripts/inspect-tn.js before being relied on here.

const { chromium } = require('playwright');
const {
  TN_LOGIN_URL,
  TN_SCHEDULING_URL,
  TN_PATIENTS_EDIT_URL,
  INTAKE_CPT,
} = require('../config');

// ---- credentials ----
// Provided via `doppler run` (agent-secrets/dev). Accept either the
// THERAPY_HOURS_TN_* names (shared) or bare TN_* names.
function loadCreds() {
  const username = process.env.THERAPY_HOURS_TN_USERNAME || process.env.TN_USERNAME;
  const password = process.env.THERAPY_HOURS_TN_PASSWORD || process.env.TN_PASSWORD;
  const practiceCode = process.env.THERAPY_HOURS_TN_PRACTICE_CODE || process.env.TN_PRACTICE_CODE;
  if (!username || !password) {
    throw new Error('TN creds missing — need THERAPY_HOURS_TN_USERNAME and THERAPY_HOURS_TN_PASSWORD (via doppler run).');
  }
  return { username, password, practiceCode };
}

// ---- date helpers ----
function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// "5 PM" / "1:30PM" / "10AM" + a YYYY-MM-DD -> Date in machine-local tz
// (assumed = practice tz, Pacific). Returns null if unparseable.
function parseApptStart(dateStr, timeStr) {
  const m = (timeStr || '').match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  let hr = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && hr !== 12) hr += 12;
  if (ampm === 'AM' && hr === 12) hr = 0;
  const d = new Date(`${dateStr}T00:00:00`);
  d.setHours(hr, min, 0, 0);
  return d;
}

// ---- browser ----
async function launch({ headless = true } = {}) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const context = await browser.newContext({ viewport: { width: 2600, height: 1100 } });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  return { browser, context, page };
}

async function login(page, creds = loadCreds()) {
  await page.goto(TN_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="login-username-input"]', { timeout: 30000 });
  await page.fill('[data-testid="login-username-input"]', creds.username);
  await page.fill('[data-testid="login-password-input"]', creds.password);
  await page.click('[data-testid="login-submit-button"]');
  // Poll the URL (TN is an SPA; waitForURL's 'load' lifecycle can hang). Fail
  // fast on an explicit auth error so a bad cred doesn't rack up lockout-
  // triggering retries.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (!/\/login\//i.test(page.url())) break;
    const rejected = await page
      .evaluate(() => /did not match any account|incorrect|invalid|locked|too many/i.test(document.body.innerText || ''))
      .catch(() => false);
    if (rejected) throw new Error('TN login rejected — check credentials in Doppler (agent-secrets/dev THERAPY_HOURS_TN_*).');
  }
  if (/\/login\//i.test(page.url())) throw new Error('TN login did not complete (still on /login/ after 30s).');
  await page.waitForSelector('a[href*="/app/scheduling"], nav, .navbar, [data-testid*="nav"]', { timeout: 20000 });
}

// ---- schedule grid ----
const MIN_CLINICIAN_COLUMNS = 8;

async function readClinicianHeaders(page) {
  return page.$$eval('.HeaderStrip.calendar-dayView-headerCell', headers =>
    headers.map(h => (h.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
  );
}

// TN's day view can render filtered to a couple clinicians. Open Set Calendar
// View, select all, save. Ported from therapy-hours.
async function resetCalendarViewIfFiltered(page) {
  const before = await readClinicianHeaders(page).catch(() => []);
  if (before.length >= MIN_CLINICIAN_COLUMNS) return before;

  const opener = await page.$('.tca-calendar-dates-text a');
  if (!opener) return before; // can't reset; caller asserts coverage
  await opener.click();
  await page.waitForTimeout(1500);

  const selectAllCandidates = [
    'button:has-text("Select All")', 'a:has-text("Select All")', 'label:has-text("Select All")',
    'input[type="checkbox"]#SelectAll', 'input[type="checkbox"][id*="ll" i][id*="select" i]',
    '[aria-label*="select all" i]',
  ];
  let selectedAll = false;
  for (const sel of selectAllCandidates) {
    const el = await page.$(sel);
    if (!el || !(await el.isVisible().catch(() => false))) continue;
    const tag = await el.evaluate(n => n.tagName.toLowerCase()).catch(() => '');
    const type = await el.evaluate(n => n.getAttribute('type') || '').catch(() => '');
    if (tag === 'input' && type.toLowerCase() === 'checkbox') {
      if (!(await el.isChecked().catch(() => false))) await el.check({ force: true });
    } else { await el.click(); }
    selectedAll = true; break;
  }
  if (!selectedAll) {
    const boxes = await page.$$('[role="dialog"] input[type="checkbox"], .ui-dialog input[type="checkbox"], .modal input[type="checkbox"]');
    for (const box of boxes) {
      if ((await box.isChecked().catch(() => null)) === false) await box.check({ force: true }).catch(() => {});
    }
  }
  const saveCandidates = [
    '#SetCalendarViewDialog__Save-Button', 'input[type="button"][value="Set Calendar View"]',
    'button:has-text("Set Calendar View")', 'button:has-text("Save")', 'button:has-text("Apply")',
    'button:has-text("OK")', 'button[type="submit"]',
  ];
  for (const sel of saveCandidates) {
    const el = await page.$(sel);
    if (!el || !(await el.isVisible().catch(() => false))) continue;
    await el.click(); break;
  }
  await page.waitForTimeout(2500);
  return readClinicianHeaders(page).catch(() => []);
}

async function gotoDay(page, dateStr) {
  const startMs = new Date(`${dateStr}T00:00:00`).getTime();
  await page.goto(`${TN_SCHEDULING_URL}#view=day&start=${startMs}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  try { await page.click('a:has-text("Day")', { timeout: 3000 }); await page.waitForTimeout(1500); } catch {}
  await resetCalendarViewIfFiltered(page);
  try { await page.waitForSelector('.calendar-daybubble', { timeout: 15000 }); } catch {}
}

// Scrape the currently-rendered day grid into flat appointment records.
// Returns [{ clinician, client, time, modality, status, aria }]. Ported from
// therapy-hours scrapeVisibleClinicians (trimmed: no callout/supervisor logic —
// the popup CPT filter is the real intake gate).
async function scrapeVisible(page) {
  return page.evaluate(() => {
    const cleanName = raw => (raw || '').replace(/\s+/g, ' ').trim().replace(/\s*\(room\s*\d+\)\s*$/i, '');
    const headers = Array.from(document.querySelectorAll('.HeaderStrip.calendar-dayView-headerCell'));
    const clinicianNames = headers.map(h => cleanName(h.textContent));
    const columns = Array.from(document.querySelectorAll('.calendar-weekview-dayColumn'));
    const colMap = new Map();
    columns.forEach((c, i) => colMap.set(c, i));

    const SESSION_TYPE_PATTERN = /(Virtual|In-person|In Person|Phone|Video|Group Therapy|Family|Couples?|Intake|Weekly|Bi-?weekly|Bi Weekly|Every Other|Session)/i;
    const SKIP_PATTERNS = [
      /^Unavailable/i, /\bMeeting\b/i, /^Lunch\b/i, /^Dinner\b/i, /^Break\b/i,
      /^Sup\s+with/i, /^Supervision\b/i, /^Case\s+Management/i, /^Out\b/i, /^Off\b/i,
      /^Vacation\b/i, /^Personal\b/i, /^Block(?:ed)?\s/i, /^Hold\b/i, /^Class\b/i,
    ];

    const bubbleText = el => el.innerHTML
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();

    const extractFullNameFromAria = aria => {
      if (!aria) return '';
      const m = aria.match(/\bfor\s+([^.]+?)\.\s/i);
      if (!m) return '';
      return m[1].replace(/\s+(COUPLES?|FAMILY|GROUP)\b.*$/i, '').trim();
    };
    const cleanClient = (raw, clinicianFirstName) => {
      let s = (raw || '').replace(/\s+/g, ' ').trim();
      s = s.replace(/^\d{1,2}(:\d{2})?\s*(AM|PM)\s*/i, '');
      s = s.replace(/\s*\((Teams|Phone|Video|In-person|In Person)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
      s = s.replace(/\s*\(Cancell?ed\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
      const stMatch = s.match(SESSION_TYPE_PATTERN);
      if (stMatch && stMatch.index > 0) s = s.slice(0, stMatch.index).trim();
      if (clinicianFirstName) {
        const parts = s.split(/\s*,\s*/).filter(Boolean);
        if (parts.length === 2) {
          const cf = clinicianFirstName.toLowerCase();
          const other = parts.find(p => p.toLowerCase() !== cf);
          if (other && parts.some(p => p.toLowerCase() === cf)) s = other;
        }
      }
      return s.replace(/\s*,\s*/g, ', ').replace(/[,.\-:;]+$/, '').trim();
    };
    const extractModality = (aria, text, bubbleEl) => {
      const haystack = `${aria || ''} ${text || ''}`;
      if (/\b(virtual|video)\b/i.test(haystack)) return 'video';
      if (/\bteams\b/i.test(haystack)) return 'video';
      if (/\bin[\s-]?person\b/i.test(haystack)) return 'in_person';
      if (/\bphone\b/i.test(haystack)) return 'phone';
      if (bubbleEl) {
        for (const ic of bubbleEl.querySelectorAll('i, svg, img')) {
          const cls = (ic.className && ic.className.baseVal != null) ? ic.className.baseVal : String(ic.className || '');
          const blob = `${cls} ${ic.getAttribute('title') || ''} ${ic.getAttribute('aria-label') || ''}`.toLowerCase();
          if (/\b(video|camera|webcam)\b/.test(blob)) return 'video';
          if (/\bphone\b/.test(blob)) return 'phone';
          if (/\b(in[\s-]?person|building|office)\b/.test(blob)) return 'in_person';
        }
      }
      return null;
    };
    const extractTime = raw => {
      const m = (raw || '').match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i);
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    };

    const out = [];
    for (const b of Array.from(document.querySelectorAll('.calendar-daybubble'))) {
      const col = b.closest('.calendar-weekview-dayColumn');
      if (!col) continue;
      const idx = colMap.get(col);
      if (idx == null || idx < 0 || idx >= clinicianNames.length) continue;

      const aria = b.getAttribute('aria-label') || '';
      const text = bubbleText(b);
      if (/^(?:Scheduled\s+)?(?:Event|Unavailable)\b/i.test(aria)) continue;
      if (SKIP_PATTERNS.some(rx => rx.test(text))) continue;

      const clinicianFirstName = (clinicianNames[idx] || '').split(/\s+/)[0];
      const client = extractFullNameFromAria(aria) || cleanClient(text, clinicianFirstName);
      if (!client) continue;
      if (SKIP_PATTERNS.some(rx => rx.test(client))) continue;

      out.push({
        clinician: clinicianNames[idx] || '',
        client,
        time: extractTime(text) || extractTime(aria),
        status: b.classList.contains('missed-or-canceled') ? 'cancelled_or_missed' : 'scheduled',
        modality: extractModality(aria, text, b),
        aria,
      });
    }
    return out;
  });
}

// Horizontal scroll sweep + merge (TN virtualizes columns).
async function scrapeDayGrid(page) {
  const mergeKey = a => `${a.clinician}||${a.time}||${a.client}`;
  let all = new Map();
  const absorb = recs => { for (const r of recs) if (!all.has(mergeKey(r))) all.set(mergeKey(r), r); };

  absorb(await scrapeVisible(page));

  const metrics = await page.evaluate(() => {
    const header = document.querySelector('.HeaderStrip.calendar-dayView-headerCell');
    const cands = Array.from(document.querySelectorAll('*')).filter(el => el && el.scrollWidth && el.clientWidth && (el.scrollWidth - el.clientWidth) > 80);
    const scroller = (header && cands.find(el => el.contains(header))) || cands[0] || null;
    return scroller ? { found: true, clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth } : { found: false };
  });
  if (metrics.found) {
    const setLeft = x => page.evaluate(left => {
      const header = document.querySelector('.HeaderStrip.calendar-dayView-headerCell');
      const cands = Array.from(document.querySelectorAll('*')).filter(el => el && el.scrollWidth && el.clientWidth && (el.scrollWidth - el.clientWidth) > 80);
      const scroller = (header && cands.find(el => el.contains(header))) || cands[0] || null;
      if (scroller) scroller.scrollLeft = left;
    }, x);
    const maxScroll = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
    const step = Math.max(350, Math.floor(metrics.clientWidth * 0.85));
    for (let x = step; x <= maxScroll; x += step) {
      await setLeft(x); await page.waitForTimeout(150); absorb(await scrapeVisible(page));
    }
    await setLeft(maxScroll); await page.waitForTimeout(150); absorb(await scrapeVisible(page));
    await setLeft(0); await page.waitForTimeout(150);
  }
  return [...all.values()];
}

// ---- appointment popup classification ----
async function closePopup(page) {
  const btn = await page.$('[data-testid="modaldialog-close-button"]');
  if (btn) await btn.click().catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await page.waitForSelector('#CalendarEntryEditor__ServiceCodeSelect', { state: 'detached', timeout: 3000 }).catch(() => {});
}

// Open an appointment's editor popup (found by its grid aria-label) and read
// the fields that classify it. Selectors confirmed against the live DOM
// (scripts/inspect-tn.js). Returns { isIntake, isTelehealth, patientId, cpt, type }
// or null if the popup can't be opened.
async function classifyAppointment(page, aria) {
  const sel = `.calendar-daybubble[aria-label="${aria.replace(/"/g, '\\"')}"]`;
  const bubble = await page.$(sel);
  if (!bubble) return null;
  await bubble.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(120);
  await bubble.click();
  try {
    await page.waitForSelector('#CalendarEntryEditor__ServiceCodeSelect', { state: 'attached', timeout: 8000 });
  } catch {
    await closePopup(page);
    return null;
  }
  const info = await page.evaluate(() => {
    const optText = (id) => {
      const el = document.getElementById(id);
      return el && el.selectedIndex >= 0 ? (el.options[el.selectedIndex]?.textContent || '') : '';
    };
    const svcText = optText('CalendarEntryEditor__ServiceCodeSelect');
    const cpt = (svcText.match(/\b(\d{5})\b/) || [])[1] || null;
    const typeText = optText('CalendarEntryEditor__TypeSelect').replace(/\s+/g, ' ').trim();
    const tele = document.getElementById('CalendarEntryEditor__TelehealthCheckbox');
    const link = document.querySelector('[role="dialog"] a[href*="/app/patients/edit/"]')
      || document.querySelector('a[href*="/app/patients/edit/"]');
    const href = link ? link.getAttribute('href') : '';
    const patientId = (href.match(/\/app\/patients\/edit\/([A-Za-z0-9_-]{6,})/) || [])[1] || null;
    return { cpt, typeText, isTelehealth: !!(tele && tele.checked), patientId };
  });
  await closePopup(page);
  return {
    isIntake: info.cpt === INTAKE_CPT || /\bintake\b/i.test(info.typeText),
    isTelehealth: info.isTelehealth,
    patientId: info.patientId,
    cpt: info.cpt,
    type: info.typeText,
  };
}

// Navigate to a patient's Documents tab and return the document list as an
// array of whole-row text strings (title + file type + date + author + status).
// Empty chart -> []. We deliberately do NOT parse table cells — TN renders them
// as web components with no <td>, so positional parsing returns nothing. The
// Azure classifier judges SOD/GAINSS presence from the row text instead, which
// is robust to naming variations, typos, and clinician-name prefixes.
async function getDocumentTitles(page, patientId) {
  const url = `${TN_PATIENTS_EDIT_URL}${patientId}/#tab=Documents`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  return page.evaluate(() => {
    const norm = t => (t || '').replace(/\s+/g, ' ').trim();
    // Empty chart: TN renders "Notes and Documents for this Patient: None".
    if (/Notes and Documents for this Patient:\s*None/i.test(norm(document.body.innerText))) return [];
    // Find the single documents table by its column headers.
    const docTable = Array.from(document.querySelectorAll('table')).find(tbl => {
      const hdr = Array.from(tbl.querySelectorAll('th')).map(th => norm(th.textContent).toLowerCase());
      return hdr.includes('document') && hdr.includes('date');
    });
    if (!docTable) return [];
    const rows = Array.from(docTable.querySelectorAll('tbody tr, tr'))
      .map(tr => norm(tr.textContent))
      .filter(t => t && !/^documentservicedate/i.test(t.replace(/\s+/g, '').toLowerCase())); // drop header row
    return Array.from(new Set(rows));
  });
}

module.exports = {
  loadCreds, ymd, parseApptStart, launch, login,
  gotoDay, scrapeDayGrid, scrapeVisible,
  classifyAppointment, getDocumentTitles, closePopup,
  TN_PATIENTS_EDIT_URL,
};
