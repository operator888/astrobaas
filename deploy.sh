#!/usr/bin/env bash
# Deploy AstroBaaS to a server -- see deploy/README.md for the full setup.
#
#   ./deploy.sh            # build + ship + flip + restart + verify
#
# Server layout (created by `new-site cms.example.com node`):
#   /var/www/<slug>/{releases,shared,current}, service
#   <slug> on 127.0.0.1:<port>. ExecStart is
#   `node ./dist/server/entry.mjs` (set once; new-site's default differs).
#   deploy/systemd/astrobaas.service is the reference unit.
#
# Runtime deps are NOT built on the server: .deploy/node_modules is a
# linux-x64 tree assembled offline (npm install --omit=dev on Linux).
# Refresh it whenever package.json's dependencies change.
#
# Persistent state lives in shared/ (survives releases), and the server-side
# half of this script (deploy/remote-activate.sh) creates any of it that is
# missing:
#   shared/.env                   secrets (AUTH_SECRET, DATABASE_URL, CORS_ORIGINS...)
#   shared/data/                  database
#   shared/data/uploads/          UPLOADS_DIR
#   shared/data/private-uploads/  PRIVATE_UPLOADS_DIR
#   shared/maintenance/           maintenance.html, shipped with every release
set -euo pipefail

# Per-deployment values come from the environment or a local override file —
# this script is committed, and a committed file is published the day the repo
# goes public. deploy.local.sh (gitignored) is the place for real values:
#
#   DEPLOY_SSH_HOST=myserver DEPLOY_SLUG=cms-my-shop ./deploy.sh
#
# Optional:
#   DEPLOY_PORT       the app's loopback port. Default: read from the unit's
#                     Environment=PORT=, then from shared/.env.
#   DEPLOY_RUN_USER   the user the app runs as. Default: the unit's User=,
#                     then www-data.
#   DEPLOY_KEEP       releases to keep (default 5).
#   DEPLOY_URL        printed at the end.
SSH_HOST="${DEPLOY_SSH_HOST:?set DEPLOY_SSH_HOST (ssh alias or host)}"
SLUG="${DEPLOY_SLUG:?set DEPLOY_SLUG (e.g. cms-example-com)}"
SERVICE="$SLUG"
BASE="/var/www/$SLUG"
TS="$(date +%Y%m%d%H%M%S)"
RELEASE="$BASE/releases/$TS"

cd "$(dirname "$0")"

test -d .deploy/node_modules || {
  echo ".deploy/node_modules missing -- assemble it on Linux with:"
  echo "  npm install --omit=dev  (then copy node_modules to .deploy/)"
  exit 1
}
test -f deploy/remote-activate.sh || { echo "deploy/remote-activate.sh missing"; exit 1; }

echo "==> Building..."
npm run build >/dev/null
test -f dist/server/entry.mjs || { echo "dist build missing"; exit 1; }
# The post-deploy mail test (deploy/README.md, 5b). A release has no src/ and
# no esbuild, so the test ships prebuilt or not at all.
test -f dist/mail-test.mjs || { echo "dist/mail-test.mjs missing -- npm run build makes it"; exit 1; }

echo "==> Assembling release..."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# mktemp -d is 0700, and `rsync -a "$STAGE/" host:$RELEASE/` below copies the
# stage's own mode onto the release root. remote-activate.sh then hands the
# release to root, and the app user cannot even cd into it: systemd fails every
# start with 200/CHDIR until its start limit gives up. That took a live site
# down on 2026-09-18. remote-activate.sh repairs a release that arrives this way
# too; this stops this script from shipping one.
chmod 0755 "$STAGE"
cp -R dist "$STAGE/dist"
cp package.json "$STAGE/package.json"
cp -R .deploy/node_modules "$STAGE/node_modules"
# db.seed.json is read at first boot when the DB is empty (optional)
cp db.seed.json "$STAGE/db.seed.json" 2>/dev/null || true
# The page nginx serves while the app is down. Generated from the same source
# as the in-app maintenance screen; remote-activate.sh moves it into
# shared/maintenance/ before the restart it exists for.
node scripts/build-maintenance-page.mjs "$STAGE/maintenance.html" >/dev/null

echo "==> Shipping to $SSH_HOST:$RELEASE..."
ssh "$SSH_HOST" "mkdir -p $(printf '%q' "$RELEASE") $(printf '%q' "$BASE/shared/data")"
rsync -a --delete --link-dest="$BASE/current/" "$STAGE/" "$SSH_HOST:$RELEASE/"

echo "==> Activating..."
# The server half is a real file, fed on stdin, with its arguments quoted for
# the remote shell. `%q` matters for the empty ones: ssh joins its arguments
# with spaces, so an unquoted empty DEPLOY_PORT would vanish and shift every
# argument after it one place to the left.
REMOTE_ARGS="$(printf '%q ' "$BASE" "$RELEASE" "$SERVICE" "${DEPLOY_PORT:-}" "${DEPLOY_RUN_USER:-}" "${DEPLOY_KEEP:-5}")"
ssh "$SSH_HOST" "bash -s -- $REMOTE_ARGS" < deploy/remote-activate.sh

echo "==> Done. ${DEPLOY_URL:-https://cms.example.com}"
