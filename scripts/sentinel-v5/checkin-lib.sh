#!/usr/bin/env bash
# Sourceable sentinel-v5 check-in helpers for blt-intake-doc-reminders' bash
# wrapper (run.sh). Ported from caller-track's scripts/sentinel-v5/checkin-lib.sh.
#
# Usage, at the very top of a wrapper (`at` and `slot` MUST be captured
# TOGETHER, before the job body runs, and NEVER recomputed at completion —
# see checkin.mjs's header):
#
#   source "$repo/scripts/sentinel-v5/checkin-lib.sh"
#   sentinel_capture_invocation idr-hourly-reminders   # sets SENTINEL_AT, SENTINEL_SLOT
#   ... job body ...
#   sentinel_checkin idr-hourly-reminders green ok "$SENTINEL_AT" "$SENTINEL_SLOT"
#
# Neither function ever fails the CALLER: a producer-side error (spool
# unwritable, unknown item, node missing, ...) never propagates a nonzero
# return — run.sh runs under `set -euo pipefail`, and a failure inside the
# telemetry must never abort the real job it is only trying to observe.
# Producer stderr is appended to a local fallback log instead of discarded,
# so a broken sentinel path still leaves a trace somewhere.
#
# Capture semantics differ from caller-track in one deliberate way: when no
# slot resolves (a manual run outside the acceptance window, or the capture
# itself failed) SENTINEL_AT/SENTINEL_SLOT stay EMPTY and sentinel_checkin
# emits nothing (desktop-janitor's checkin-helper semantics). A hand-run
# `./run.sh --dry-run` at 14:02 must not claim the 13:35 slot, and if the
# producer is broken the sentinel's own absence detection is the alarm.
SENTINEL_FALLBACK_LOG="${SENTINEL_FALLBACK_LOG:-$HOME/.blt-sentinel/logs/blt-intake-doc-reminders-fallback.log}"

SENTINEL_CHECKIN_MJS="${SENTINEL_CHECKIN_MJS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/checkin.mjs}"
# run.sh pins node@22; anything else on this Mac may be a different major.
SENTINEL_NODE="${SENTINEL_NODE:-node}"

SENTINEL_AT=""
SENTINEL_SLOT=""

sentinel_log_fallback_failure() {
  local context="$1" detail="$2"
  mkdir -p "$(dirname "$SENTINEL_FALLBACK_LOG")" 2>/dev/null || true
  printf '[%s] %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$context" "$detail" >> "$SENTINEL_FALLBACK_LOG" 2>/dev/null || true
}

# sentinel_capture_invocation <item> — sets SENTINEL_AT and SENTINEL_SLOT as a
# side effect (bash has no clean multi-value return). Leaves both empty on any
# failure; see the header for why.
sentinel_capture_invocation() {
  local item="$1"
  local capture="" err="" errfile="" extra=""
  SENTINEL_AT=""
  SENTINEL_SLOT=""
  errfile="$(mktemp 2>/dev/null || true)"
  if [ -n "$errfile" ]; then
    capture="$("$SENTINEL_NODE" "$SENTINEL_CHECKIN_MJS" --capture-invocation --item "$item" 2>"$errfile")" || {
      err="$(cat "$errfile" 2>/dev/null || true)"
      sentinel_log_fallback_failure "capture-invocation:$item" "${err:-unknown error}"
      capture=""
    }
    rm -f "$errfile" 2>/dev/null || true
  else
    capture="$("$SENTINEL_NODE" "$SENTINEL_CHECKIN_MJS" --capture-invocation --item "$item" 2>/dev/null)" || {
      sentinel_log_fallback_failure "capture-invocation:$item" "failed (mktemp unavailable, no stderr detail captured)"
      capture=""
    }
  fi
  if [ -n "$capture" ]; then
    IFS=$'\t' read -r SENTINEL_AT SENTINEL_SLOT extra <<< "$capture"
    if [ -n "${extra:-}" ]; then
      SENTINEL_AT=""
      SENTINEL_SLOT=""
    fi
  fi
  if [ -z "$SENTINEL_AT" ] || [ -z "$SENTINEL_SLOT" ]; then
    if [ -n "$capture" ]; then
      sentinel_log_fallback_failure "capture-invocation:$item" "malformed output: $capture"
    fi
    SENTINEL_AT=""
    SENTINEL_SLOT=""
  fi
  return 0
}

# sentinel_checkin <item> <green|red|yellow> <reason_code> <at> <slot>
# (second local is `check_status`, not `status` — zsh reserves that name.)
sentinel_checkin() {
  local item="$1" check_status="$2" reason_code="$3" at="${4:-}" slot="${5:-}"
  local err=""
  if [ -z "$at" ] || [ -z "$slot" ]; then
    sentinel_log_fallback_failure "checkin:$item:$check_status" "no slot captured at invocation start; not emitting"
    return 0
  fi
  if ! err="$("$SENTINEL_NODE" "$SENTINEL_CHECKIN_MJS" \
    --item "$item" \
    --status "$check_status" \
    --reason-code "$reason_code" \
    --at "$at" \
    --slot "$slot" \
    2>&1 >/dev/null)"; then
    sentinel_log_fallback_failure "checkin:$item:$check_status" "${err:-unknown error}"
  fi
  return 0
}
