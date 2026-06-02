// classify.js — Azure OpenAI judgment of whether a chart's document list
// contains a SOD and a GAINSS, robust to naming variations, typos, and
// clinician-name prefixes. BAA-covered inference (Azure OpenAI under BLT's M365
// tenant). Call pattern copied from therapy-hours/lib/parse.js.

const { AzureOpenAI } = require('openai');

const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';

function creds() {
  const apiKey = process.env.BLT_AZURE_OPENAI_API_KEY || process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.BLT_AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = process.env.BLT_AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT;
  if (!apiKey || !endpoint || !deployment) {
    throw new Error('Azure OpenAI env missing — need BLT_AZURE_OPENAI_API_KEY / _ENDPOINT / _DEPLOYMENT (via doppler run).');
  }
  return { apiKey, endpoint, deployment };
}

const SYSTEM_PROMPT = `You inspect a TherapyNotes patient chart's document list and decide whether two specific intake forms are present.

1. SOD — a client disclosure/consent form. Title varies: "SOD", "<Clinician Name> SOD", "Statement of Disclosure", "Disclosure Statement". Often a DOCX. Misspellings of the name happen (e.g. "Matsyik" for "Matysik").
2. GAINSS — a behavioral-health screening assessment (Global Appraisal of Individual Needs - Short Screener). Title varies: "GAINSS", "GAIN-SS", "GAIN SS", "GAINS". Often a PDF.

You receive the raw rows of the chart's "Notes and Documents" list. Each row may include the document title plus file type/size, date, author/clinician name, and a status. Judge by intent of the document title, not exact string match. The clinician's name appearing in a SOD title does not disqualify it.

Generic chart items are NOT a SOD or GAINSS: "Progress Note", "Treatment Plan", "Intake Note", "Psychotherapy Note", and unrelated uploads (e.g. "Resources.pdf").

Output STRICT JSON only — no prose, no markdown fences:
{
  "hasSOD": boolean,
  "hasGAINSS": boolean,
  "sodEvidence": "the matching row text, or empty string",
  "gainssEvidence": "the matching row text, or empty string"
}

If a form is not clearly present, set its boolean false and its evidence "".`;

async function classifyDocs(rows) {
  const list = (rows || []).map(r => String(r || '').trim()).filter(Boolean);
  // No documents at all -> nothing present. Skip the API call.
  if (list.length === 0) return { hasSOD: false, hasGAINSS: false, sodEvidence: '', gainssEvidence: '' };

  const { apiKey, endpoint, deployment } = creds();
  const client = new AzureOpenAI({ endpoint, apiKey, apiVersion: API_VERSION, deployment });

  const userMessage = ['Chart documents:', '---', ...list.map((r, i) => `${i + 1}. ${r}`), '---'].join('\n');

  const call = messages => client.chat.completions.create({
    model: deployment,
    // This Azure deployment is a reasoning-class model: it requires
    // max_completion_tokens (not max_tokens) and only supports the default
    // temperature (so we omit it). Budget covers hidden reasoning + the JSON.
    max_completion_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
  });
  const text = r => (r.choices?.[0]?.message?.content || '').trim();
  const clean = t => t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let raw = clean(text(await call([{ role: 'user', content: userMessage }])));
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    raw = clean(text(await call([{ role: 'user', content: `${userMessage}\n\nReturn ONLY the JSON object.` }])));
    parsed = JSON.parse(raw);
  }
  return {
    hasSOD: !!parsed.hasSOD,
    hasGAINSS: !!parsed.hasGAINSS,
    sodEvidence: String(parsed.sodEvidence || ''),
    gainssEvidence: String(parsed.gainssEvidence || ''),
  };
}

module.exports = { classifyDocs };
