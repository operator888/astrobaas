#!/usr/bin/env bash
# AstroBaaS — activate a shipped release. Runs ON THE SERVER, as root.
#
# deploy.sh feeds this file to the server over ssh:
#
#   ssh host bash -s -- <base> <release> <service> [port] [run-user] [keep] < deploy/remote-activate.sh
#
#   base      /var/www/<slug>
#   release   /var/www/<slug>/releases/<timestamp>   (already rsynced)
#   service   the systemd unit name
#   port      optional; read from the unit's Environment=PORT=, then shared/.env
#   run-user  optional; read from the unit's User=, default www-data
#   keep      optional; releases to keep, default 5
#
# WHY THIS IS A FILE AND NOT A STRING INSIDE deploy.sh
#
# It used to be a double-quoted string, and nothing checked it: `bash -n`
# cannot see inside a string, and a string is not something a test can run. So
# it shipped with a health check URL that still said `http://127.0.0.1:<port>/`
# — a placeholder nobody replaced. curl refused it on every deploy, `set -e`
# aborted, and the release clean-up after it never ran. As a file it is
# syntax-checked and exercised end to end by tests/deploy-artifacts.test.mjs,
# with systemctl and curl stubbed.
set -euo pipefail

BASE="${1:?usage: remote-activate.sh <base> <release> <service> [port] [run-user] [keep]}"
RELEASE="${2:?release directory required}"
SERVICE="${3:?service name required}"
PORT="${4:-}"
RUN_USER="${5:-}"
KEEP="${6:-5}"
# Readiness polling: 30 tries x 2 s. Migrations run at boot, and /readyz stays
# 503 until they finish, so this has to allow for a slow one.
READY_TRIES="${ASTROBAAS_READY_TRIES:-30}"
READY_SLEEP="${ASTROBAAS_READY_SLEEP:-2}"

test -d "$RELEASE" || { echo "release $RELEASE does not exist" >&2; exit 1; }
case "$KEEP" in ''|*[!0-9]*) echo "keep must be a number, got '$KEEP'" >&2; exit 1 ;; esac
[ "$KEEP" -ge 2 ] || KEEP=2   # never prune the release we might roll back to

# --- Who the app runs as ------------------------------------------------------
#
# Read from the unit rather than assumed. This script used to chown everything
# to `site-$SLUG` while the reference unit runs as www-data, so the app could
# not write its own database or uploads after the first deploy. The unit is
# what actually decides; ask it.
if [ -z "$RUN_USER" ]; then
  RUN_USER="$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)"
fi
RUN_USER="${RUN_USER:-www-data}"
RUN_GROUP="$(systemctl show -p Group --value "$SERVICE" 2>/dev/null || true)"
RUN_GROUP="${RUN_GROUP:-$RUN_USER}"

# --- Which port to probe ------------------------------------------------------
if [ -z "$PORT" ]; then
  # `|| true` inside: under pipefail a unit systemctl cannot describe would
  # otherwise end the script here instead of falling through to shared/.env.
  PORT="$( { systemctl show -p Environment --value "$SERVICE" 2>/dev/null \
    | tr ' ' '\n' | sed -n 's/^PORT=//p' | tail -n 1; } || true)"
fi
if [ -z "$PORT" ] && [ -f "$BASE/shared/.env" ]; then
  PORT="$( { sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([0-9][0-9]*\).*/\1/p' \
    "$BASE/shared/.env" | tail -n 1; } || true)"
fi
case "$PORT" in
  ''|*[!0-9]*)
    echo "Cannot tell which port $SERVICE listens on." >&2
    echo "Set Environment=PORT=... in the unit, PORT=... in $BASE/shared/.env, or DEPLOY_PORT for deploy.sh." >&2
    exit 1 ;;
esac

# --- The persistent layout ----------------------------------------------------
#
# Everything the app writes lives under shared/, and a first deploy onto a
# fresh box must not depend on somebody having created it by hand:
#
#   shared/data/                  database (DB_PATH, or a file: DATABASE_URL)
#   shared/data/uploads/          UPLOADS_DIR — nginx serves images from here
#   shared/data/private-uploads/  PRIVATE_UPLOADS_DIR — strangers' form files;
#                                 NOT world-readable, nothing but the app reads it
#   shared/maintenance/           the page nginx shows while the app is down
#
# shared/.env is NOT touched: it holds AUTH_SECRET and belongs to root, readable
# by the app's group (0640). Handing it to the app user, as the old `chown -R
# ... shared` did, lets a compromised process rewrite its own secrets.
mkdir -p "$BASE/shared/data/uploads" "$BASE/shared/data/private-uploads" "$BASE/shared/maintenance"
chown -R "$RUN_USER:$RUN_GROUP" "$BASE/shared/data"
chmod 0750 "$BASE/shared/data/private-uploads"
chmod 0755 "$BASE/shared/maintenance"

# The code is readable by the app and owned by root: a compromised process
# should not be able to rewrite what it runs on the next boot (the unit's
# ProtectSystem=strict enforces the same thing from the other side).
chown -R "root:$RUN_GROUP" "$RELEASE"
# ...and READABLE by it, which the chown alone does not make it. deploy.sh
# stages a release in `mktemp -d`, which is 0700, and rsync copied that mode onto
# the release root. Owned by root, 0700, it could not be entered by the app, and
# systemd failed every start with 200/CHDIR until its start limit gave up — the
# service down, and the readiness loop below only able to say so. deploy.sh no
# longer ships one like that, but a release can arrive by other routes, so the
# mode is set here, before `current` points at it: the root enterable, and
# everything under it group-readable, directories group-traversable. Never
# group-writable: the app must not be able to change its own code. `g+rX` only
# ADDS bits, so a release built under umask 002 (0775/0664, the Debian/Ubuntu
# default for a user with their own group) kept its group-write — `g-w` takes it
# away explicitly.
chmod 0755 "$RELEASE"
chmod -R g+rX,g-w "$RELEASE"

# The maintenance page goes in BEFORE the restart, because the restart is the
# window it exists for. Copy-then-rename so nginx never reads half a file.
if [ -f "$RELEASE/maintenance.html" ]; then
  cp "$RELEASE/maintenance.html" "$BASE/shared/maintenance/.maintenance.html.tmp"
  chmod 0644 "$BASE/shared/maintenance/.maintenance.html.tmp"
  mv -f "$BASE/shared/maintenance/.maintenance.html.tmp" "$BASE/shared/maintenance/maintenance.html"
fi

# --- Flip and restart ---------------------------------------------------------
PREVIOUS="$(readlink "$BASE/current" 2>/dev/null || true)"
ln -sfn "$RELEASE" "$BASE/current"
# `restart` sends SIGTERM and waits for the app's graceful drain (in-flight
# requests, buffered views) up to the unit's TimeoutStopSec.
systemctl restart "$SERVICE"

# --- Ready, not merely alive --------------------------------------------------
#
# /readyz, not /healthz. /healthz is 200 as soon as storage answers a read;
# /readyz stays 503 until migrations have brought the schema up to this build.
# Declaring a deploy good on /healthz can put traffic on a half-migrated
# database. Probed on loopback, directly — not through nginx, which restricts
# /readyz and could be the thing that is broken.
ready=0
i=0
while [ "$i" -lt "$READY_TRIES" ]; do
  i=$((i + 1))
  if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/readyz"; then
    ready=1
    break
  fi
  sleep "$READY_SLEEP"
done

if [ "$ready" != 1 ]; then
  echo "!! $SERVICE is not ready on 127.0.0.1:$PORT after $READY_TRIES tries." >&2
  systemctl status --no-pager "$SERVICE" >&2 || true
  journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
  if [ -n "$PREVIOUS" ]; then
    # Not automatic. Migrations have run against the NEW code by now, and
    # putting the old code back on a newer schema is a decision, not a reflex.
    echo "To roll back: ln -sfn '$PREVIOUS' '$BASE/current' && systemctl restart '$SERVICE'" >&2
  fi
  exit 1
fi
echo "ready: http://127.0.0.1:$PORT/readyz"

# --- Keep the newest $KEEP releases --------------------------------------------
#
# Only after the new one is known to be ready, and never the one `current`
# points at or the one it pointed at before. Ordered by NAME, which is the
# deploy timestamp (YYYYmmddHHMMSS) — not by mtime, which a chown, a restore or
# an rsync of an old tree can move.
for d in "$BASE"/releases/*; do
  # `if`, not `[ ] &&`: under pipefail a false test as the loop's last command
  # fails the whole pipeline, and set -e would end a successful deploy there.
  if [ -d "$d" ]; then printf '%s\n' "$d"; fi
done | sort -r | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
  [ "$old" = "$RELEASE" ] && continue
  [ -n "$PREVIOUS" ] && [ "$old" = "$PREVIOUS" ] && continue
  rm -rf -- "$old"
done
