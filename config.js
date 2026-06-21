// config.js — central config for blt-intake-doc-reminders.
//
// Edit this file (not the source) to change recipients, the clinician email
// map, detection patterns, or timing. Everything PHI-adjacent (patient names,
// appointment times) only ever leaves this machine via Microsoft Graph to
// @balancedlivingtherapy.com mailboxes — inside BLT's M365 tenant, covered by
// the Microsoft BAA. Do not add non-BAA recipients here.

// ---- Mail ----
const SENDER = 'jesse@balancedlivingtherapy.com';
const FRONTDESK = 'frontdesk@balancedlivingtherapy.com'; // Armaan / front desk
const ESCALATION_CC = ['jesse@balancedlivingtherapy.com']; // CC'd on the 3h "still missing" escalation
// jesse@ is CC'd on every email (nag, escalation, confirm) for oversight.
const ALWAYS_CC = ['jesse@balancedlivingtherapy.com'];

// Daily digest / heartbeat: once a day, on the first hourly run at or after
// this local hour, email jesse@ a summary of today's virtual intakes and
// whether each already has its SOD and GAINSS. Confirms the system is alive.
const DIGEST_HOUR = 8;
const DIGEST_TO = SENDER;

// Clinician display name (exactly as it appears in the TN schedule grid header)
// -> work email. Copied from therapy-hours/config.js. Used to address the
// "docs are in" confirmation to the treating therapist. If a clinician is not
// found here, the confirmation is skipped and logged rather than guessed.
const CLINICIAN_EMAILS = {
  'Brad Corcoran': 'brad@balancedlivingtherapy.com',
  'Stacy Gardea': 'stacyg@balancedlivingtherapy.com',
  'Michaela Gayer': 'michaela@balancedlivingtherapy.com',
  'Maggie (Gigi) Ishaq': 'gigi@balancedlivingtherapy.com',
  'Alicia Kuoch': 'alicia@balancedlivingtherapy.com',
  'Ally Latham': 'ally@balancedlivingtherapy.com',
  'Taylor Likes': 'taylorl@balancedlivingtherapy.com',
  'Claire Popke': 'claire@balancedlivingtherapy.com',
  'Kristi Lyn Reddy': 'kristilyn@balancedlivingtherapy.com',
  'Sam Stephens': 'sam@balancedlivingtherapy.com',
  'Tessa Tesoriero': 'tessa@balancedlivingtherapy.com',
  'Thomas Matysik': 'thomas@balancedlivingtherapy.com',
  'Beth Wareing': 'beth@balancedlivingtherapy.com',
  'Ash Campbell': 'ash@balancedlivingtherapy.com',
  'Ray Power': 'ray@balancedlivingtherapy.com',
  'Jesse Dunn': 'jesse@balancedlivingtherapy.com',
};

// ---- TherapyNotes ----
const TN_LOGIN_URL = 'https://www.therapynotes.com/app/login/BALANCED5/';
const TN_SCHEDULING_URL = 'https://www.therapynotes.com/app/scheduling/';
// Patient chart edit page; append "<patientId>/#tab=Documents".
const TN_PATIENTS_EDIT_URL = 'https://www.therapynotes.com/app/patients/edit/';

// Intake appointments are CPT 90791 ("Therapy Intake"). Authoritative signal,
// read from the appointment popup's Service Code <select>.
const INTAKE_CPT = '90791';

// ---- Document detection ----
// A chart "has" a form when any document/note title on the Documents tab
// matches. Observed titles: "<Client Name> SOD" (DOCX) and "GAINSS" (PDF).
// Patterns tolerate spacing/hyphen variants. Tune here if BLT renames.
const DOC_PATTERNS = {
  SOD: /\bSOD\b/i,
  GAINSS: /GAIN[\s-]?SS/i,
};

// ---- Timing ----
// How far ahead to look for intakes each run. 30h so an hourly run the day
// before always covers tomorrow's full day regardless of the run hour.
const WINDOW_HOURS = 30;
// "Within 3 hours of the session" — escalation re-nag threshold.
const ESCALATION_HOURS = 3;

module.exports = {
  SENDER,
  FRONTDESK,
  ESCALATION_CC,
  ALWAYS_CC,
  CLINICIAN_EMAILS,
  TN_LOGIN_URL,
  TN_SCHEDULING_URL,
  TN_PATIENTS_EDIT_URL,
  INTAKE_CPT,
  DOC_PATTERNS,
  WINDOW_HOURS,
  ESCALATION_HOURS,
  DIGEST_HOUR,
  DIGEST_TO,
};
