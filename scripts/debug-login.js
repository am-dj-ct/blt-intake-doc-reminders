#!/usr/bin/env node
// debug-login.js — diagnose the TN login. Builds the login URL from the
// Doppler practice code (not the hardcoded BALANCED5), dumps the form fields
// (so we confirm the right selectors + whether the practice code is prefilled),
// then attempts login and reports. Login/verify pages have no PHI. Prints no
// secret values — only lengths/booleans.
//
//   doppler run -p therapy-hours -c dev -- node scripts/debug-login.js [--headful]

const fs = require('fs');
const path = require('path');
const tn = require('../lib/tn');

(async () => {
  const headless = !process.argv.includes('--headful');
  const { browser, page } = await tn.launch({ headless });
  const creds = tn.loadCreds();
  const dbg = path.join(__dirname, '..', 'debug');
  fs.mkdirSync(dbg, { recursive: true });

  const practice = creds.practiceCode || 'BALANCED5';
  const loginUrl = `https://www.therapynotes.com/app/login/${practice}/`;
  console.log(`practiceCode length=${(creds.practiceCode || '').length}  ==BALANCED5? ${practice === 'BALANCED5'}  userLen=${(creds.username||'').length} passLen=${(creds.password||'').length}`);

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    console.log('login page:', page.url());
    await page.waitForTimeout(1500);

    const fields = await page.evaluate(() => {
      const norm = t => (t || '').replace(/\s+/g, ' ').trim();
      const labelFor = el => {
        if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return norm(l.textContent); }
        const w = el.closest('label'); if (w) return norm(w.textContent);
        return '';
      };
      return Array.from(document.querySelectorAll('input, select')).map(el => ({
        tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', id: el.id || '',
        name: el.name || '', testid: el.getAttribute('data-testid') || '',
        placeholder: el.getAttribute('placeholder') || '', valueLen: (el.value || '').length, label: labelFor(el),
      }));
    });
    console.log('FORM FIELDS:\n', JSON.stringify(fields, null, 2));

    await page.fill('[data-testid="login-username-input"]', creds.username);
    await page.fill('[data-testid="login-password-input"]', creds.password);
    console.log('creds filled; submitting…');
    await page.click('[data-testid="login-submit-button"]');

    const deadline = Date.now() + 45000;
    let last = '';
    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);
      const u = page.url();
      if (u !== last) { console.log('  url ->', u); last = u; }
      if (!/\/login\//i.test(u)) break;
    }
    if (/\/login\//i.test(page.url())) {
      await page.screenshot({ path: path.join(dbg, 'login-result.png'), fullPage: true }).catch(() => {});
      const bodyText = (await page.evaluate(() => document.body.innerText || '')).replace(/\s+/g, ' ').slice(0, 500);
      console.log('\nSTILL ON LOGIN:', page.url());
      console.log('body:', bodyText);
    } else {
      console.log('\nLOGIN OK — reached', page.url());
    }
  } catch (e) {
    console.error('debug-login error:', e.message);
    await page.screenshot({ path: path.join(dbg, 'login-error.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
})();
