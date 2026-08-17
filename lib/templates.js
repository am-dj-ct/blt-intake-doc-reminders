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

// Daily digest / heartbeat -> jesse@. Lists today's virtual intakes and
// whether each has its SOD and GAINSS as of this run.
function digest({ ranAt, dateLabel, intakes }) {
  const n = intakes.length;
  const mark = b => (b ? '✓' : '✗');
  const body = n === 0
    ? '<p>No virtual intakes scheduled for today.</p>'
    : '<ul>' + intakes.map(i =>
        `<li>${i.time} — <b>${i.client}</b> (${i.clinician}) — SOD ${mark(i.hasSOD)} &middot; GAINSS ${mark(i.hasGAINSS)}</li>`
      ).join('') + '</ul>';
  return {
    subject: n === 0
      ? 'BLT intake check — no virtual intakes today'
      : `BLT intake check — ${n} virtual intake${n === 1 ? '' : 's'} today (${dateLabel})`,
    html: p(`Daily check — the intake reminder ran at ${ranAt} and is working.`)
      + `<p><b>Virtual intakes today (${dateLabel}):</b></p>`
      + body + TAG,
  };
}

// Scrape-health alert -> sentinel mailbox. Alert-class, deliberately no PHI:
// dates, counts and ok/unprovable flags only, never a client or clinician name.
function scrapeAlert({ ranAt, dateLabel, todayIntakeCount, days }) {
  const rows = days.map(d => `<li>${d.ymd} — ${d.ok ? 'scraped clean' : 'UNPROVABLE (load failed or clinician view filtered)'}</li>`).join('');
  return {
    subject: `BLT intake-doc-reminders — scrape not fully verified (${dateLabel})`,
    html: p(`The intake-doc reminder ran at ${ranAt} but could not fully verify its schedule scrape. Reminder coverage for the unprovable day(s) is not guaranteed.`)
      + `<p><b>Day status:</b></p><ul>${rows}</ul>`
      + p(`Virtual intakes counted today: ${todayIntakeCount}.`)
      + TAG,
  };
}

module.exports = { nag, escalation, confirm, digest, scrapeAlert };
