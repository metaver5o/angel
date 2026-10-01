#!/usr/bin/env bash
# Local auto-deploy: pull origin/main and rebuild the stack when it changed.
# Driven by cron every 5 minutes (see `make install-cron` note in README).
# Safe to run by hand too.
set -euo pipefail

REPO="/Users/marco/code/skrybit/Angel"
LOG="$REPO/deploy.log"
LOCK="$REPO/.deploy.lock"

# cron runs with a minimal PATH; docker (Desktop) and git live here.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

# Single instance: a build can outlast the 5-minute tick. mkdir is atomic.
if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

cd "$REPO"
git fetch -q origin main || { echo "[$(date)] fetch failed" >>"$LOG"; exit 0; }

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
if [ "$local_sha" = "$remote_sha" ]; then
  exit 0   # nothing new
fi

{
  echo "[$(date)] deploy ${local_sha:0:7} -> ${remote_sha:0:7}"
  # reset --hard only touches tracked files, so the untracked .env is preserved.
  git reset --hard origin/main
  docker compose up -d --build
  echo "[$(date)] done"
} >>"$LOG" 2>&1
