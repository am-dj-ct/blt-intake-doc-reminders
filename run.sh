#!/bin/bash
# run.sh — entry point for launchd and manual runs. Injects secrets via Doppler
# (agent-secrets/dev) and runs the hourly check. Extra args pass through, e.g.:
#   ./run.sh --dry-run
#   ./run.sh --test
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")" || exit 1
# TN multi-account broker (spec: TN-ACCOUNT-SPEC-V4-2026-07-28.md). These two
# lines ARE the go-live switch for this job — merging this onto the live
# checkout takes effect on the very next hourly run, no separate flip step.
export TN_ACCOUNT_SYSTEM=1
export TN_ACCOUNT=blta
exec doppler run -p agent-secrets -c dev -- node index.js "$@"
