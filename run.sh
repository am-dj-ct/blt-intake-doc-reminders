#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TN_ACCOUNT_SYSTEM=1
export TN_ACCOUNT=blta

# Resolved from this script's own location; the launch agent runs
# /Users/alexmercer/blt-intake-doc-reminders/run.sh, so production resolves to
# that checkout, and the smoke test can exercise a worktree copy.
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node_bin="/opt/homebrew/opt/node@22/bin/node"

# ---- Sentinel v5 (BLT fleet monitor) ------------------------------------
# Capture the invocation slot FIRST, before anything that can fail, so a run
# that dies in attestation or TN login still checks in red instead of going
# silent. Both helpers never fail this wrapper; see checkin-lib.sh.
SENTINEL_ITEM="idr-hourly-reminders"
SENTINEL_NODE="$node_bin"
# shellcheck source=scripts/sentinel-v5/checkin-lib.sh
source "$repo/scripts/sentinel-v5/checkin-lib.sh"
sentinel_capture_invocation "$SENTINEL_ITEM"

# Side channel for the "degraded" verdict: index.js writes one word here when
# the run finished (exit 0) but could not fully trust its own scrape (a day
# failed to load or the clinician view was still filtered). Zero intakes on a
# quiet day is NOT degraded — that is green by design.
health_file="$(mktemp 2>/dev/null || true)"
if [[ -n "$health_file" ]]; then
  export BLT_INTAKE_DOC_REMINDERS_HEALTH_FILE="$health_file"
fi

run_job() {
  local own_head="${BLT_INTAKE_DOC_REMINDERS_EXPECTED_HEAD:-}"
  local own_tree="${BLT_INTAKE_DOC_REMINDERS_EXPECTED_TREE:-}"
  local broker_head="${TN_ACCOUNT_BROKER_EXPECTED_HEAD:-}"
  local broker_tree="${TN_ACCOUNT_BROKER_EXPECTED_TREE:-}"
  local broker_root="${TN_ACCOUNT_BROKER_ROOT:-}"
  if [[ ! "$own_head" =~ ^[0-9a-f]{40}$ || ! "$own_tree" =~ ^[0-9a-f]{40}$ ||
        ! "$broker_head" =~ ^[0-9a-f]{40}$ || ! "$broker_tree" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Intake reminders refused: application and broker heads and trees are not pinned.\n' >&2
    return 64
  fi
  if [[ "$broker_root" != "/Users/alexmercer/.openclaw/runtime/therapynotes-ppt-${broker_head:0:12}" ]]; then
    printf 'Intake reminders refused: broker root is not the immutable reviewed install.\n' >&2
    return 64
  fi
  "$node_bin" "$repo/scripts/verify-runtime-checkout.js" \
    --root "$repo" --head "$own_head" --tree "$own_tree" >/dev/null || return 65
  "$node_bin" "$repo/scripts/verify-runtime-checkout.js" \
    --root "$broker_root" --head "$broker_head" --tree "$broker_tree" >/dev/null || return 65

  /opt/homebrew/bin/doppler run --silent --no-fallback -p agent-secrets -c dev -- \
    "$node_bin" "$repo/index.js" "$@"
}

# Test seam for the sentinel smoke test ONLY: substitute the job body with a
# synthetic script. Honored solely when this wrapper is itself invoked with
# --dry-run, so it can never stand in for a real (sending) run.
dry_run=0
for arg in "$@"; do [[ "$arg" == "--dry-run" ]] && dry_run=1; done

rc=0
if [[ -n "${BLT_INTAKE_DOC_REMINDERS_JOB_OVERRIDE:-}" && "$dry_run" == "1" ]]; then
  "$BLT_INTAKE_DOC_REMINDERS_JOB_OVERRIDE" "$@" || rc=$?
else
  run_job "$@" || rc=$?
fi

health=""
if [[ -n "$health_file" && -s "$health_file" ]]; then
  health="$(head -c 64 "$health_file" | tr -d '[:space:]')"
fi
if [[ -n "$health_file" ]]; then rm -f "$health_file"; fi

if [[ "$rc" != "0" ]]; then
  # Attestation refusal (64/65), TN login/scrape failure, send failure, crash.
  sentinel_checkin "$SENTINEL_ITEM" red job_failed "$SENTINEL_AT" "$SENTINEL_SLOT"
elif [[ "$health" == "degraded" ]]; then
  sentinel_checkin "$SENTINEL_ITEM" yellow degraded "$SENTINEL_AT" "$SENTINEL_SLOT"
else
  sentinel_checkin "$SENTINEL_ITEM" green ok "$SENTINEL_AT" "$SENTINEL_SLOT"
fi

exit "$rc"
