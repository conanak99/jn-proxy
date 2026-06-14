#!/usr/bin/env bash
# Pull, install, restart. Run from the directory this script lives in.
#
# Differences vs the old references/image-proxy-playwright/deploy.sh:
#   - No `pkill -f chromium` — there is no browser to clean up anymore.
#   - Uses `bun install` (not `npm install`).
#   - Reinstalls `curl_cffi` if the system Python is missing it, since the
#     /generateAlpha bypass depends on it.
#   - Auto-detects the current branch (the old script was pinned to a branch
#     called `playwright`).

set -euo pipefail

# Run from the directory containing this script regardless of where it was
# invoked from. Lets PM2 / cron / a CI runner call it with any cwd.
cd "$(dirname "$0")"

BRANCH="${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
echo "[deploy] branch: $BRANCH"

# Hard reset to remote head — matches the old deploy.sh behaviour.
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# Bun deps
rm -rf node_modules
bun install --frozen-lockfile --production

# Python helper for /generateAlpha Cloudflare bypass.
PYTHON_BIN="${JANITOR_PYTHON:-python3}"
if ! "$PYTHON_BIN" -c 'import curl_cffi' >/dev/null 2>&1; then
  echo "[deploy] installing curl_cffi for $PYTHON_BIN"
  # --break-system-packages is required on Debian/Ubuntu's PEP 668 pythons.
  "$PYTHON_BIN" -m pip install --break-system-packages --no-cache-dir curl_cffi
fi

# Start or restart via pm2. `startOrRestart` works whether the app is already
# registered or not, exactly like the old deploy.
pm2 startOrRestart pm2.config.cjs
pm2 save
