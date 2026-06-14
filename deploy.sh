#!/usr/bin/env bash
# Pull, install, restart. Run from the directory this script lives in.
#
# Differences vs the old references/image-proxy-playwright/deploy.sh:
#   - No `pkill -f chromium` — there is no browser to clean up anymore.
#   - Uses `bun install` (not `npm install`).
#   - Installs `curl_cffi` into a project-local venv (./venv) instead of the
#     system Python. This avoids the Debian/Ubuntu PEP 668 trap where pip
#     can't upgrade apt-installed deps (e.g. `Cannot uninstall cffi 1.16.0,
#     RECORD file not found. Hint: The package was installed by debian.`)
#     because apt packages don't ship pip RECORD files.
#   - Auto-detects the current branch (the old script was pinned to a branch
#     called `playwright`).
#
# Requirements on the host:
#   - bun        (curl -fsSL https://bun.sh/install | bash)
#   - pm2        (npm i -g pm2)
#   - python3 + python3-venv (apt install -y python3 python3-venv)

set -euo pipefail

cd "$(dirname "$0")"

BRANCH="${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
echo "[deploy] branch: $BRANCH"

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# Bun deps
rm -rf node_modules
bun install --frozen-lockfile --production

# ----- Python venv with curl_cffi (Cloudflare bypass for /generateAlpha) -----
VENV_DIR="${VENV_DIR:-./venv}"
SYSTEM_PYTHON="${SYSTEM_PYTHON:-python3}"

if [[ ! -x "$VENV_DIR/bin/python3" ]]; then
  echo "[deploy] creating venv at $VENV_DIR"
  "$SYSTEM_PYTHON" -m venv "$VENV_DIR"
fi

VENV_PY="$VENV_DIR/bin/python3"

# Pin curl_cffi to the version we tested against. Bump intentionally.
CURL_CFFI_VERSION="${CURL_CFFI_VERSION:-0.15.0}"

if ! "$VENV_PY" -c "import curl_cffi, sys; sys.exit(0 if curl_cffi.__version__ == '$CURL_CFFI_VERSION' else 1)" >/dev/null 2>&1; then
  echo "[deploy] installing curl_cffi==$CURL_CFFI_VERSION into $VENV_DIR"
  "$VENV_PY" -m pip install --upgrade pip
  "$VENV_PY" -m pip install --no-cache-dir "curl_cffi==$CURL_CFFI_VERSION"
fi

# Expose the venv python to pm2.config.cjs (which already honours JANITOR_PYTHON).
export JANITOR_PYTHON="$(cd "$(dirname "$VENV_PY")" && pwd)/python3"
echo "[deploy] JANITOR_PYTHON=$JANITOR_PYTHON"

pm2 startOrRestart pm2.config.cjs --update-env
pm2 save
