// send.js — Microsoft Graph sendMail wrapper.
//
// Ported from blt-survey-reminders/lib/send.js. App-only (client credentials)
// auth; sends FROM jesse@balancedlivingtherapy.com. Reads creds from BLT_GRAPH_*
// env vars (provide via `doppler run`). Every recipient must be inside the
// @balancedlivingtherapy.com tenant — PHI (client names) only travels inside
// BLT's M365 BAA this way.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const { SENDER } = require('../config');

async function getAccessToken() {
  const tenant = process.env.BLT_GRAPH_TENANT_ID || 'balancedlivingtherapy.com';
  const client = process.env.BLT_GRAPH_CLIENT_ID;
  const secret = process.env.BLT_GRAPH_CLIENT_SECRET;
  if (!client || !secret) {
    throw new Error(
      'Graph env vars missing — need BLT_GRAPH_CLIENT_ID and BLT_GRAPH_CLIENT_SECRET ' +
      '(BLT_GRAPH_TENANT_ID optional, defaults to balancedlivingtherapy.com).'
    );
  }
  const body = new URLSearchParams();
  body.set('client_id', client);
  body.set('client_secret', secret);
  body.set('scope', 'https://graph.microsoft.com/.default');
  body.set('grant_type', 'client_credentials');
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Graph token HTTP ${res.status}: ${t.slice(0, 240)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Graph token response missing access_token');
  return data.access_token;
}

function toRecipientList(addrs) {
  return (Array.isArray(addrs) ? addrs : [addrs])
    .filter(Boolean)
    .map(addr => ({ emailAddress: { address: addr } }));
}

async function sendEmail({ to, cc, subject, html }) {
  const token = await getAccessToken();
  const message = {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: toRecipientList(to),
      ccRecipients: toRecipientList(cc || []),
    },
    saveToSentItems: true,
  };
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(SENDER)}/sendMail`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Graph sendMail HTTP ${res.status}: ${t.slice(0, 400)}`);
  }
  // Graph sendMail returns 202 Accepted with no body.
  return 'graph-accepted';
}

module.exports = { sendEmail };
