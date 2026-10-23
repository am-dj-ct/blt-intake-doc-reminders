#!/usr/bin/env bash
# The intake-doc reminders' one watcher (Jesse, 2026-09-26): runs 21:00 daily.
# Emails jesse@ ONLY when no hourly run finished cleanly today, or when 3+ of
# today's hourly slots (07:35-20:35) failed, timed out, never ran, or were
# skipped for a busy TherapyNotes login while an intake was still missing
# documents. A busy skip with nothing waiting is the job's designed retry and
# does not count (2026-10-22: 10-20 and 10-22 mailed on harmless skips alone).
# Silence means the day was fine. Counts only; nothing from the chart or the
# schedule goes into the email.
set -uo pipefail
ROOT="${IDR_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUN_LOG="${IDR_WATCH_RUN_LOG:-$ROOT/data/run.log}"
MAX_BAD="${IDR_WATCH_MAX_BAD:-3}"
TO="${IDR_WATCH_TO:-jesse@balancedlivingtherapy.com}"
FROM="${IDR_WATCH_FROM:-Intake Doc Reminders <notifications@alerts.ctpipeline.com>}"
NOW="${IDR_WATCH_NOW:-}"   # ISO timestamp override, tests only

# A run still in progress (the 20:35 slot can run up to 30 min) is not a failure.
running=0
if [ -z "$NOW" ] && pgrep -f "$ROOT/(run.sh|index.js)" >/dev/null 2>&1; then running=1; fi

verdict="$(python3 - "$RUN_LOG" "$MAX_BAD" "$running" "$NOW" <<'PY'
import re, sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
log_path, max_bad, running, now_arg = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1", sys.argv[4]
pt = ZoneInfo("America/Los_Angeles")
now = datetime.fromisoformat(now_arg).astimezone(pt) if now_arg else datetime.now(pt)
today = now.date()

# Split the log into runs by header; a run is clean if it reached "Done."
# without a busy skip, a FAILED line, or a timeout kill. A clean run that
# printed an intake with "| docs: missing" left something waiting.
runs, cur = [], None
header = re.compile(r"^=== BLT intake-doc reminder — now=(\S+)")
try:
    with open(log_path, errors="replace") as f:
        for line in f:
            m = header.match(line)
            if m:
                try:
                    start = datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).astimezone(pt)
                except ValueError:
                    cur = None
                    continue
                cur = {"start": start, "done": False, "bad": False, "busy": False, "waiting": False}
                runs.append(cur)
                continue
            if cur is None:
                continue
            if line.startswith("Done."):
                cur["done"] = True
            elif line.startswith("FAILED") or "[timeout]" in line:
                cur["bad"] = True
            elif "[skip] TN account busy" in line:
                cur["busy"] = True
            elif "| docs: missing" in line:
                cur["waiting"] = True
except FileNotFoundError:
    pass

# Hourly slots 07:35..20:35 that should have run by now.
slots = [h for h in range(7, 21) if (now.hour, now.minute) >= (h, 35)]
if running and slots:
    slots = slots[:-1]

# A busy skip is the designed retry of the job: it prints Done. and the next hour
# tries again. It only costs something when the last clean run before it saw
# an intake still missing documents. With no clean run before it in the log,
# nothing proves the queue was empty, so it counts as bad.
waiting = None
for r in runs:
    if r["busy"]:
        r["harmless_skip"] = waiting is False
    elif r["done"] and not r["bad"]:
        waiting = r["waiting"]

def is_today(r):
    return r["start"].date() == today and r["done"] and not r["bad"]

# Zero-clean rule: only a run that actually checked counts, never a skip.
clean_hours = {r["start"].hour for r in runs if is_today(r) and not r["busy"]}
ok_hours = clean_hours | {r["start"].hour for r in runs
                          if is_today(r) and r["busy"] and r["harmless_skip"]}
clean = len([h for h in slots if h in clean_hours])
ok = len([h for h in slots if h in ok_hours])
missed = len(slots) - ok
problems = []
if slots and clean == 0:
    problems.append(f"no hourly run finished cleanly today (0 of {len(slots)} slots)")
elif missed >= max_bad:
    problems.append(f"{missed} of {len(slots)} hourly runs today failed, timed out, skipped while an intake was waiting, or never ran ({ok} ok)")
skips = ok - clean
note = f", {skips} busy skip(s) with nothing waiting" if skips else ""
print(("PROBLEM " if problems else "OK ") + (problems[0] if problems else f"{clean} of {len(slots)} hourly runs clean today{note}"))
PY
)"

if [ "${verdict%% *}" = "OK" ]; then
  echo "intake-doc-watch: ${verdict#OK }"
  exit 0
fi

msg="${verdict#PROBLEM }"
echo "intake-doc-watch: PROBLEM: $msg" >&2
if [ "${IDR_WATCH_DRY:-0}" = "1" ]; then echo "intake-doc-watch: dry run, no email"; exit 1; fi
payload="$(mktemp)"
python3 - "$payload" "$TO" "$FROM" "$msg" "${IDR_WATCH_SUBJECT_PREFIX:-}" <<'PY'
import json, sys
p, to, sender, msg, prefix = sys.argv[1:6]
json.dump({"from": sender, "to": [to],
  "subject": f"{prefix}Intake doc reminders had a bad day",
  "text": msg + "\n\nRun log: ~/blt-intake-doc-reminders/data/run.log\nJob: launchctl print gui/$UID/com.blt.intake-doc-reminders\n"},
  open(p, "w"))
PY
IDR_WATCH_PAYLOAD="$payload" doppler run -p agent-secrets -c dev -- sh -c \
  'curl -s --fail --max-time 20 -X POST https://api.resend.com/emails -H "Authorization: Bearer $RESEND_API_KEY" -H "content-type: application/json" -d "@$IDR_WATCH_PAYLOAD"' >/dev/null \
  && echo "intake-doc-watch: emailed $TO" || echo "intake-doc-watch: EMAIL FAILED" >&2
rm -f "$payload"
exit 1
