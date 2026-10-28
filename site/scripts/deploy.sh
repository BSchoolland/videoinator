#!/usr/bin/env bash
# Ship the site to personal-server and restart it under pm2. Never touches data/ or the server's ecosystem file.
set -euo pipefail
HOST="${DEPLOY_HOST:-personal-server}"
DEST="/root/apps/videoinator"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# a server that doesn't compile never leaves this machine
"${BUN:-$HOME/.bun/bin/bun}" build "$HERE/src/server.ts" --target=bun --outfile=/tmp/videoinator-deploy-check.js >/dev/null
rsync -az --delete --exclude 'data/' --exclude 'node_modules/' --exclude 'deploy/ecosystem.config.cjs' "$HERE/" "$HOST:$DEST/"
ssh "$HOST" "cd $DEST && (pm2 restart videoinator --update-env || pm2 start deploy/ecosystem.config.cjs) && pm2 save" >/dev/null
sleep 2
ssh "$HOST" "curl -fsS -o /dev/null -w 'local %{http_code}\n' http://127.0.0.1:3020/healthz"
