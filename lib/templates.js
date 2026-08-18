// templates.js — email subject + HTML for each stage. Jesse's voice: short,
// direct, no filler. Each ends with an automated tag. All recipients are
// internal BLT mailboxes, so client name + appointment time are fine to include.

function p(...lines) {
  return lines.filter(l => l != null).map(l => `<p>${l}</p>`).join('\n');
}

const TAG = '<p style="color:#888;font-size:12px">(automated — BLT intake doc reminder)</p>';

function firstName(full) {
  return (full || '').trim().split(/\s+/)[0] || (full || '');
}

// "SOD and GAINSS" / "GAINSS"
function missingPhrase(missing) {
  return missing.length === 2 ? `${missing[0]} and ${missing[1]}` : missing[0];
}

// Stage 1 — first sighting, docs missing. To: frontdesk@ (Armaan).
function nag({ client, clinicianName, apptHuman, missing }) {
  const docs = missingPhrase(missing);
  const plural = missing.length === 2;
  return {
    subject: `Intake docs needed — ${client} (${apptHuman})`,
    html: p(
      'Hey Armaan,',
      `${client} has a <b>virtual intake</b> ${apptHuman} with ${clinicianName}, and the ${docs} ${plural ? 'are' : 'is'} not in the chart yet.`,
      `Since it's telehealth, the client needs to complete the ${docs} in TherapyNotes before the session — there's no in-person chance to catch it. Please reach out and get ${plural ? 'them' : 'it'} uploaded.`,
      `I'll keep checking and ping you again if ${plural ? "they're" : "it's"} still missing 3 hours before the session.`
    ) + TAG,
  };
}

// Stage 2 — still missing within 3h of start. To: frontdesk@, CC: jesse@.
function escalation({ client, clinicianName, apptHuman, missing, hoursLeft }) {
  const docs = missingPhrase(missing);
  const plural = missing.length === 2;
  return {
    subject: `STILL MISSING intake docs — ${client}, session in ~${hoursLeft}h`,
    html: p(
      'Hey Armaan,',
      `${client}'s virtual intake with ${clinicianName} is ${apptHuman} (about ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'} out) and the ${docs} still ${plural ? 'are not' : 'is not'} in the chart.`,
      `This is the last automated check before the session. Please chase ${plural ? 'them' : 'it'} down now if at all possible.`
    ) + TAG,
  };
}

// Stage 3 — both docs present. To: therapist, CC: frontdesk@.
function confirm({ client, clinicianName, apptHuman }) {
  return {
    subject: `Intake docs received — ${client}`,
    html: p(
      `Hi ${firstName(clinicianName)},`,
      `The SOD and GAINSS for <b>${client}</b> (virtual intake ${apptHuman}) are now in the chart in TherapyNotes. You're all set for the session.`
    ) + TAG,
  };
}

// Daily digest, split in two (Jesse ruling 2026-08-17):
//
//   digestReport() — the PHI detail (client names, times, per-client doc
//   status). NEVER emailed. Written to a local file under data/digests/
//   inside the protected boundary.
//
//   digestStatus() — the NO-PHI status/heartbeat mail -> sentinel@. Counts,
//   statuses, and the local report path only. No client names, no times,
//   no per-client anything. Machine-read; envelopes must stay PHI-safe.
function digestReport({ ranAt, dateLabel, intakes }) {
  const n = intakes.length;
  const mark = b => (b ? '✓' : '✗');
  const body = n === 0
    ? '<p>No virtual intakes scheduled for today.</p>'
    : '<ul>' + intakes.map(i =>
        `<li>${i.time} — <b>${i.client}</b> (${i.clinician}) — SOD ${mark(i.hasSOD)} &middot; GAINSS ${mark(i.hasGAINSS)}</li>`
      ).join('') + '</ul>';
  return '<p>BLT intake doc check — local report. Do not email this file.</p>'
    + p(`Run: ${ranAt}`)
    + `<p><b>Virtual intakes today (${dateLabel}):</b></p>`
    + body + TAG;
}

function digestStatus({ ranAt, dateLabel, total, docsComplete, missingSOD, missingGAINSS, scrapeHealth, reportPath }) {
  return {
    subject: `[idr] daily status — ${total} intake${total === 1 ? '' : 's'} today, scrape ${scrapeHealth} (${dateLabel})`,
    html: p(
      `Intake doc reminder heartbeat — ran at ${ranAt}.`,
      `intakes_today=${total} docs_complete=${docsComplete} missing_sod=${missingSOD} missing_gainss=${missingGAINSS} scrape=${scrapeHealth}`,
      reportPath ? `Detail (in-boundary, not emailed): ${reportPath}` : null
    ) + TAG,
  };
}

module.exports = { nag, escalation, confirm, digestReport, digestStatus };
