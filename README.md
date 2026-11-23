# BLT Intake Doc Reminders

Reminds front desk (Armaan) to collect the **SOD** and **GAINSS** from clients before **virtual/telehealth intakes** in TherapyNotes, escalates if they're still missing close to the session, and confirms to the treating therapist once both land.

In-person intakes are skipped — those forms get collected at the visit.

## How it works

Runs hourly (7am–8pm) on the Mac. Each run:

1. **Scrape schedule** — logs into TherapyNotes (Playwright + system Chrome), reads today + tomorrow's day view across all clinicians.
2. **Find virtual intakes** — takes every scheduled appointment in the next 30h, opens each appointment's editor popup and keeps the ones that are **CPT 90791 / "Therapy Intake"** *and* have the **Telehealth** box checked. The grid bubble's own wording ("Virtual", "Video") is never used to decide: until 2026-11-12 it was a pre-filter, and a telehealth intake whose bubble carried none of those words was never opened and never reminded. Classifications are cached (`data/appts.json`) so repeat runs don't re-open popups.
3. **Check the chart** — opens each intake patient's **Documents** tab, reads the document list, and asks **Azure OpenAI** (BAA-covered) whether a SOD and a GAINSS are present. The LLM handles naming variation, typos, and clinician-name prefixes (e.g. a SOD titled "Thomas Matsyik SOD").
4. **Act** (one email max per appointment + stage, tracked in `data/sent.json`):
   - **nag** — docs missing, >3h before start → email **frontdesk@**
   - **escalation** — docs missing, ≤3h before start → email **frontdesk@**, cc **jesse@**
   - **confirm** — both docs present → email the **therapist**, cc **frontdesk@**

## HIPAA / BAA

- The only network calls are to **TherapyNotes**, **Microsoft Graph** (email), and **Azure OpenAI** — all inside BLT's BAA coverage. No PHI goes to any non-BAA service.
- Routine director-only copies of nags and confirmations are folded into Jesse's existing Saturday Weekly Hours overview. Before omitting that CC, dispatch durably records a count-only immutable event under `~/.blt-hub/reports/weekly-director/intake` (`BLT_WEEKLY_DIRECTOR_ROOT` override). A failed local handoff retains the original Jesse CC and makes the existing job fail loudly after recording staff delivery. Urgent escalation CCs and Jesse's own treating-clinician confirmations remain immediate. No client identity is stored in the event payload; test/dry runs never write events.
- Email is sent from **jesse@balancedlivingtherapy.com** via Graph; all recipients are inside the `@balancedlivingtherapy.com` tenant, so client names in the body stay in-tenant.
- Inference (the doc-presence judgment) uses **Azure OpenAI** under BLT's tenant, never a third-party model.

## Secrets (Doppler: `agent-secrets/dev`)

Injected at runtime via `doppler run`. Present and working:

- The canonical TherapyNotes broker resolves the approved `blta` / `blt2` /
  `bltj` account credentials at runtime, in that order (bltj joined the
  ordinary standard pool 2026-09-14). This repo never reads a legacy
  credential file.
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
verifies that restoration before returning an error. Immediately before any
launchd unload, the same installer records a 15-minute expiring restart receipt
for `com.blt.intake-doc-reminders`; it completes that receipt only after the new
state or a rollback is verified. Logs remain in
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
| healthy job exited 0 | green `ok` |
| 6 distinct service dates have scheduled candidates but zero intakes of any format | red status + existing health side-channel after reminder work and teardown; existing red `job_failed` check-in |
| Chrome launch, TN login, identity read, or login-marker release exceeds its stage deadline | red `job_failed` (pages; status artifact records `tn_browser_launch_timeout`, `tn_login_timeout`, `tn_identity_timeout`, or `tn_login_marker_timeout`) |
| job exited 0 but a day failed to load / clinician view still filtered | status artifact `scrapeHealth: degraded`; no check-in (exit 0) |
| job exited non-zero: 30-minute wall-clock timeout, pin/attestation refusal, TN login failure, scrape or send error, crash | red `job_failed` (pages) |
| no check-in by slot + grace | the sentinel's own missed-slot detection (pages) |

The wrapper captures the slot before anything that can fail, never lets a
telemetry error abort the real job, and emits nothing for a manual run
outside the slot's acceptance window (see `scripts/sentinel-v5/checkin-lib.sh`).
Producer-side failures are appended to
`~/.blt-sentinel/logs/blt-intake-doc-reminders-fallback.log`. If the schedule
in the plist changes, change the fragment row's cron to match.

### Intake classification signal

`data/status/latest.json` records `zeroIntakeCandidateDays`, its count in
`zeroIntakeCandidateStreak`, `zeroIntakeStreakUnit: "service_days"`, and
`zeroIntakeAlertDays: 6`. Repeated hourly visits to the same service date count
once, including tomorrow's appointments inside the 30-hour window. A service
date means an actual candidate-bearing date, including weekends with work.
Empty runs preserve the set; any detected intake (in person or telehealth)
resets it. The legacy hourly count is discarded on upgrade.

The threshold is one above the longest observed normal gap: 130 completed
all-format runs from Nov 12–22, 2026 showed five candidate-bearing service
dates (Nov 13–17) without an intake before a positive detection. Earlier logs
counted only video candidates/intakes and cannot establish all-format gaps.
This is limited history, not proof that longer normal gaps are impossible.
At six dates the job still completes staff notices and cleanup, then writes red
to the wrapper's existing health side-channel for a red Sentinel check-in.
It retains the completion marker so the daily watcher does not mislabel a
classification anomaly as a teardown failure. Login/timeout failures preserve
the accumulated service-date evidence.
The Hub reminders trust probe and dashboard health script read freshness,
counts, and scrape health, but do not inspect classification `health` or
`alertCode`; the local digest does not read status.

### Daily status email removed (2026-10-07)

The job no longer sends the daily "[idr] daily status" email (it went to the
unread `sentinel@` mailbox). The once-a-day local digest report
(`data/digests/<date>.html`, PHI, never emailed) and the run status artifact
(`data/status/latest.json`) are still written. The job's one watcher is
`scripts/watch-intake-doc.sh` (`com.jesse.intake-doc-reminders-watch`, 21:00
daily): it emails jesse@ only when no hourly run finished cleanly, or when 3 or
more hourly runs failed, timed out, or never ran. A skip because the shared
TherapyNotes login was busy counts only when the last clean run before it saw
an intake still missing documents (since 2026-10-22). `index.js` no
longer writes the health side-channel file `run.sh` used for yellow/red
check-ins on exit-0 runs.

## Files

- `index.js` — orchestrator + state machine + CLI
- `lib/tn.js` — TherapyNotes login, schedule scrape, appointment classification, Documents read
- `lib/classify.js` — Azure OpenAI SOD/GAINSS presence judgment
- `lib/send.js` — Microsoft Graph sendMail
- `lib/templates.js` — the three email templates
- `lib/ledger.js` — per-(client+appt+stage) sent record (`data/sent.json`)
- `config.js` — recipients, clinician→email map, CPT, timing
- `scripts/` — `inspect-tn.js`, `check-docs.js`, `debug-login.js` (diagnostics)
- `scripts/install-mac-launchagent.js`, `install-mac-launchagent.sh`, `run.sh` — reviewed scheduling and transactional cutover

## Tuning

`config.js`: `WINDOW_HOURS` (30), `ESCALATION_HOURS` (3), `CLINICIAN_EMAILS`, `DOC_PATTERNS` (regex fallback; the Azure classifier is primary).

## Status / not yet verified

- Scrape → intake/telehealth detection → Documents read → Azure classify → nag/escalation decisions: **verified** against the live schedule (dry run).
- **Email send is unverified** — no Graph client secret available yet to test `--test`.
- The **confirm** path is wired but not observed live (no current intake has its docs in yet).

### Bounded profile cleanup (2026-11-20)

The intake job owns its runtime behavior; pay-period-tracker owns the canonical
account broker. The live checkout is updated only by BLT Hub's registered
sibling release controller (`docs/sibling-release-autodeploy.md` in blt-hub),
which applies the reviewed main commit and calls this repo's transactional
installer. Do not pull or edit that deployment checkout by hand.

Both prelaunch preparation and post-browser profile cleanup run in a separate
process with a 60-second SIGKILL deadline. That helper verifies the parent job's
exact account ownership and confirms no browser uses the selected profile.
It atomically moves `Default/Cache` and `Default/Code Cache`, Chrome's
disposable HTTP and compiled-code caches, into a private sibling directory
outside the active profile, while retaining cookies and other login state.
Preparation never recursively deletes those caches: a large but healthy cache
must not consume the preparation deadline and prevent reminder work. Chrome
also has a 10 MiB disk-cache target.
The unchanged, pinned broker's envelope verification/resealing runs in the same
bounded helper; the canonical release closure still shuts down its own timers
and releases only the original lock. A failed security/reseal helper records
`tn_profile_cleanup_timeout` or `tn_profile_cleanup_failed`; no unsafe release
or account failover is authorized by a timeout. The canonical broker releases
its exact lock on setup failure. A security/reseal failure during teardown
still refuses release.

Only after browser death and canonical lock release are confirmed, a separate
bounded helper recursively deletes the retired caches. Its 60-second deadline
still kills a stuck deletion, but that cannot retain the TN login or prevent
completed reminders from finishing. Unfinished deletion logs the fixed warning
`tn_cache_gc_deferred lockReleased=true` and is retried after the next successful
run. No new job or watcher is installed.

After completed reminder work the log records `[work-complete] status=ok`.
Recovered graceful-close trouble records `tn_teardown_recovered`, then an ok
status and `Done.` with elapsed milliseconds and released-lock confirmation.
The process explicitly exits after stdout flush so an abandoned Playwright
transport cannot keep it alive after safe release. The existing daily watcher
counts recovered teardown separately and alerts on unresolved teardown without
calling already-completed reminder work a missed intake.
