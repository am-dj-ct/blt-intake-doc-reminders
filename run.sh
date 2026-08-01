#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TN_ACCOUNT_SYSTEM=1
export TN_ACCOUNT=blta

repo="/Users/alexmercer/blt-intake-doc-reminders"
own_head="${BLT_INTAKE_DOC_REMINDERS_EXPECTED_HEAD:-}"
own_tree="${BLT_INTAKE_DOC_REMINDERS_EXPECTED_TREE:-}"
broker_head="${TN_ACCOUNT_BROKER_EXPECTED_HEAD:-}"
broker_tree="${TN_ACCOUNT_BROKER_EXPECTED_TREE:-}"
broker_root="${TN_ACCOUNT_BROKER_ROOT:-}"
if [[ ! "$own_head" =~ ^[0-9a-f]{40}$ || ! "$own_tree" =~ ^[0-9a-f]{40}$ ||
      ! "$broker_head" =~ ^[0-9a-f]{40}$ || ! "$broker_tree" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Intake reminders refused: application and broker heads and trees are not pinned.\n' >&2
  exit 64
fi
if [[ "$broker_root" != "/Users/alexmercer/.openclaw/runtime/therapynotes-ppt-${broker_head:0:12}" ]]; then
  printf 'Intake reminders refused: broker root is not the immutable reviewed install.\n' >&2
  exit 64
fi
/opt/homebrew/opt/node@22/bin/node "$repo/scripts/verify-runtime-checkout.js" \
  --root "$repo" --head "$own_head" --tree "$own_tree" >/dev/null || exit 65
/opt/homebrew/opt/node@22/bin/node "$repo/scripts/verify-runtime-checkout.js" \
  --root "$broker_root" --head "$broker_head" --tree "$broker_tree" >/dev/null || exit 65

exec /opt/homebrew/bin/doppler run --silent --no-fallback -p agent-secrets -c dev -- \
  /opt/homebrew/opt/node@22/bin/node "$repo/index.js" "$@"
