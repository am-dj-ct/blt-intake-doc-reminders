#!/usr/bin/env bash
set -euo pipefail

exec /opt/homebrew/opt/node@22/bin/node \
  "$(cd "$(dirname "$0")" && pwd)/scripts/install-mac-launchagent.js" "$@"
