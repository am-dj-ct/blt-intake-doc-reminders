#!/bin/bash
# run.sh — entry point for launchd and manual runs. Injects secrets via Doppler
# (agent-secrets/dev) and runs the hourly check. Extra args pass through, e.g.:
#   ./run.sh --dry-run
#   ./run.sh --test
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")" || exit 1
exec doppler run -p agent-secrets -c dev -- node index.js "$@"
