# BLT Intake Doc Reminders

Reminds front desk (Armaan) to collect the **SOD** and **GAINSS** from clients before **virtual/telehealth intakes** in TherapyNotes, escalates if they're still missing close to the session, and confirms to the treating therapist once both land.

In-person intakes are skipped — those forms get collected at the visit.

## How it works

Runs hourly (7am–8pm) on the Mac. Each run:

1. **Scrape schedule** — logs into TherapyNotes (Playwright + system Chrome), reads today + tomorrow's day view across all clinicians.
2. **Find virtual intakes** — keeps scheduled *video* appointments in the next 30h, opens each appointment's editor popup and keeps the ones that are **CPT 90791 / "Therapy Intake"** *and* have the **Telehealth** box checked. Classifications are cached (`data/appts.json`) so repeat runs don't re-open popups.
3. **Check the chart** — opens each intake patient's **Documents** tab, reads the document list, and asks **Azure OpenAI** (BAA-covered) whether a SOD and a GAINSS are present. The LLM handles naming variation, typos, and clinician-name prefixes (e.g. a SOD titled "Thomas Matsyik SOD").
4. **Act** (one email max per appointment + stage, tracked in `data/sent.json`):
   - **nag** — docs missing, >3h before start → email **frontdesk@**
   - **escalation** — docs missing, ≤3h before start → email **frontdesk@**, cc **jesse@**
   - **confirm** — both docs present → email the **therapist**, cc **frontdesk@**

## HIPAA / BAA

- The only network calls are to **TherapyNotes**, **Microsoft Graph** (email), and **Azure OpenAI** — all inside BLT's BAA coverage. No PHI goes to any non-BAA service.
- Email is sent from **jesse@balancedlivingtherapy.com** via Graph; all recipients are inside the `@balancedlivingtherapy.com` tenant, so client names in the body stay in-tenant.
- Inference (the doc-presence judgment) uses **Azure OpenAI** under BLT's tenant, never a third-party model.

## Secrets (Doppler: `agent-secrets/dev`)

Injected at runtime via `doppler run`. Present and working:

- The canonical TherapyNotes broker resolves the approved `blta` / `blt2`
  account credentials at runtime. This repo never reads a legacy credential
  file or chooses a third account.
- `BLT_AZURE_OPENAI_ENDPOINT` / `BLT_AZURE_OPENAI_DEPLOYMENT` / `BLT_AZURE_OPENAI_API_KEY` — doc classifier

**Still needed before live email can send** (not currently in Doppler):

- `BLT_GRAPH_CLIENT_SECRET` — client secret for the Graph app (`BLT_GRAPH_CLIENT_ID` is already in Doppler). The app must have **Mail.Send (Application)** consented for jesse@.
- `BLT_GRAPH_TENANT_ID` — optional; defaults to `balancedlivingtherapy.com`.

`BLT_GRAPH_CLIENT_ID` is already present.

## Setup

```bash
npm install            # installs playwright (uses system Chrome; no browser download)
```

## Running

```bash
# dry run — scrape + classify + decide, print actions, send nothing, ledger untouched
doppler run -p agent-secrets -c dev -- node index.js --dry-run

# test — route every email to jesse@ only, subject prefixed [TEST] (needs the Graph secret)
doppler run -p agent-secrets -c dev -- node index.js --test

# live
doppler run -p agent-secrets -c dev -- node index.js

# helpers
./run.sh --dry-run                       # same, via the wrapper
node scripts/check-docs.js <patientId>   # validate doc scrape + classifier on one chart
```

Flags: `--dry-run`, `--test`, `--force` (ignore ledger), `--date YYYY-MM-DD` / `--time HH:MM` (override "now"), `--headful` (watch the browser).

## Scheduling (launchd)

After the reviewed application commit is checked out and the reviewed broker
commit has an immutable runtime install, pass their exact heads, trees, and
broker root to the preflight and transactional installer:

```bash
BLT_INTAKE_DOC_REMINDERS_EXPECTED_HEAD=<exact-app-head> \
BLT_INTAKE_DOC_REMINDERS_EXPECTED_TREE=<exact-app-tree> \
TN_ACCOUNT_BROKER_ROOT=/Users/alexmercer/.openclaw/runtime/therapynotes-ppt-<broker-head-12> \
TN_ACCOUNT_BROKER_EXPECTED_HEAD=<exact-broker-head> \
TN_ACCOUNT_BROKER_EXPECTED_TREE=<exact-broker-tree> \
./install-mac-launchagent.sh --check

# Run the same command with --install only after the preflight succeeds.
```

The installer backs up the prior plist and loaded/disabled state, replaces it
atomically, and verifies the result. Any failure rolls all three back and
verifies that restoration before returning an error. Logs remain in
`data/run.log`.

Runs hourly 7am–8pm so day-before nags don't fire overnight. Edit the `StartCalendarInterval` array to change hours.

### Sentinel v5 (fleet monitor) check-ins

`run.sh` reports every scheduled run to the BLT Sentinel v5 spool
(`~/.blt-sentinel/spool`) as item `idr-hourly-reminders`, registered in blt-hub's
`config/sentinel-v5-registry.json` (this repo's copy of the row:
`config/sentinel-v5-registry-fragment.blt-intake-doc-reminders.json`, schedule
`35 7-20 * * *` Pacific, tier T1, page class `client_staff_facing_outage`).

| Outcome | Check-in |
| --- | --- |
| job exited 0 | green `ok` (a quiet day with zero intakes is green — the digest gate handles that by design) |
| job exited 0 but a day failed to load / clinician view still filtered | yellow `degraded` (digest only) |
| job exited non-zero: pin/attestation refusal, TN login failure, scrape or send error, crash | red `job_failed` (pages) |
| no check-in by slot + grace | the sentinel's own missed-slot detection (pages) |

The wrapper captures the slot before anything that can fail, never lets a
telemetry error abort the real job, and emits nothing for a manual run
outside the slot's acceptance window (see `scripts/sentinel-v5/checkin-lib.sh`).
Producer-side failures are appended to
`~/.blt-sentinel/logs/blt-intake-doc-reminders-fallback.log`. If the schedule
in the plist changes, change the fragment row's cron to match.

## Files

- `index.js` — orchestrator + state machine + CLI
- `lib/tn.js` — TherapyNotes login, schedule scrape, appointment classification, Documents read
- `lib/classify.js` — Azure OpenAI SOD/GAINSS presence judgment
- `lib/send.js` — Microsoft Graph sendMail
- `lib/templates.js` — the three email templates
- `lib/ledger.js` — per-(patient+appt+stage) sent record (`data/sent.json`)
- `config.js` — recipients, clinician→email map, CPT, timing
- `scripts/` — `inspect-tn.js`, `check-docs.js`, `debug-login.js` (diagnostics)
- `scripts/install-mac-launchagent.js`, `install-mac-launchagent.sh`, `run.sh` — reviewed scheduling and transactional cutover

## Tuning

`config.js`: `WINDOW_HOURS` (30), `ESCALATION_HOURS` (3), `CLINICIAN_EMAILS`, `DOC_PATTERNS` (regex fallback; the Azure classifier is primary).

## Status / not yet verified

- Scrape → intake/telehealth detection → Documents read → Azure classify → nag/escalation decisions: **verified** against the live schedule (dry run).
- **Email send is unverified** — no Graph client secret available yet to test `--test`.
- The **confirm** path is wired but not observed live (no current intake has its docs in yet).
