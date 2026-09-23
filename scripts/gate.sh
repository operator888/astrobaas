#!/usr/bin/env bash
# The full verification gate, with the one thing that keeps going wrong done first.
#
# Both the smoke suite and Playwright refuse to start when something is already
# serving their port, and Astro 7 backgrounds `astro dev` in an agent
# environment — so a killed run leaves a server holding 4321 or 4399 and the
# NEXT run fails for a reason that has nothing to do with the code. That has
# cost four false failures already — the fourth was a stale `dist/`, which this
# also clears, because Astro content-hashes the server chunks it renames.
#
# Usage:  bash scripts/gate.sh [quick]
#   quick  = astro check + unit + the default-driver smoke only
set -uo pipefail
cd "$(dirname "$0")/.."

reap() {
  # Anything serving one of our ports, whatever started it.
  ps ax -o pid,command \
    | grep -E "dist/server/entry\.mjs|astro\.mjs dev" \
    | grep -v grep \
    | awk '{print $1}' \
    | xargs -r kill -9 2>/dev/null
  sleep 3
  # And a STALE dist. Astro content-hashes its server chunks, so a rebuild
  # renames them — a reaped server that had the old names loaded is gone, but
  # the e2e webServer starting on a half-replaced dist gets
  # ERR_MODULE_NOT_FOUND for a chunk that no longer exists, and Playwright
  # reports four unrelated test failures. That cost a fourth false failure.
  rm -rf dist
}

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
fail=0
note() { if [ "$1" -eq 0 ]; then echo "   ✓ $2"; else echo "   ✗ $2"; fail=1; fi; }

reap

# BEFORE anything is measured: are we even measuring the right tree?
#
# CI runs `npm ci`, which installs the lockfile exactly; a developer's
# node_modules drifts and nothing says so. When @types/node sat at 20.19.43 on
# disk against a lockfile pinning 26.4.0, this gate printed GATE GREEN while CI
# printed a real ts(2345) in committed code — the type-checker here could not
# see it, because it was reading three-year-old definitions. Every step below
# is only as meaningful as this one.
step "dependencies"
node scripts/check-deps.mjs > /tmp/gate-deps.log 2>&1
deps=$?
note $deps "dependencies match package-lock.json"
if [ $deps -ne 0 ]; then
  cat /tmp/gate-deps.log
  # Stop rather than continue. Carrying on would produce a pass/fail list that
  # says nothing about CI, which is worse than no list — the four false
  # failures in the header above were all cases of a result that looked
  # authoritative and was not.
  printf '\n\033[1m%s\033[0m\n' 'GATE RED'
  exit 1
fi

step "astro check"
out=$(npx astro check 2>&1 | grep -E '^- ' | tr '\n' ' ')
echo "   $out"
case "$out" in *"0 errors"*) note 0 "types" ;; *) note 1 "types: $out" ;; esac

step "unit"
npm run test:unit > /tmp/gate-unit.log 2>&1
note $? "unit"
grep -E '^✗' /tmp/gate-unit.log | head -5

if [ "${1:-}" = "quick" ]; then
  step "smoke (default driver)"
  npm run smoke > /tmp/gate-smoke.log 2>&1
  note $? "smoke — $(grep -oE '[0-9]+ passed, [0-9]+ failed' /tmp/gate-smoke.log | tail -1)"
  grep -E '^✗' /tmp/gate-smoke.log | head -5
  exit $fail
fi

for s in smoke smoke:libsql smoke:relational; do
  step "$s"
  npm run "$s" > "/tmp/gate-${s//:/-}.log" 2>&1
  rc=$?
  count=$(grep -oE '[0-9]+ passed, [0-9]+ failed' "/tmp/gate-${s//:/-}.log" | tail -1)
  note $rc "$s — ${count:-no result}"
  grep -E '^✗' "/tmp/gate-${s//:/-}.log" | head -5
  # An EMPTY count means the suite never ran — it did not fail an assertion, it
  # refused to start. Overwhelmingly that is a port already served by something
  # else, and the suite says so in words the gate was throwing away. Printing
  # nothing there sent one debugging session looking for a code bug that was a
  # neighbouring project's dev server. `reap` cannot fix this: it kills by
  # process pattern across the whole machine, and widening that pattern to
  # catch a foreign server is how the gate would start killing somebody's
  # unrelated work.
  if [ -z "$count" ]; then
    grep -E 'Refusing to start|ALREADY serving|EADDRINUSE|Kill it first' \
      "/tmp/gate-${s//:/-}.log" | head -4
    echo "   (SMOKE_PORT=<free port> npm run $s  runs it elsewhere)"
  fi
done

reap
step "e2e"
npm run e2e > /tmp/gate-e2e.log 2>&1
note $? "e2e — $(grep -oE '[0-9]+ passed' /tmp/gate-e2e.log | tail -1)"
grep -E '^\s+[0-9]\) ' /tmp/gate-e2e.log | head -5
reap

printf '\n\033[1m%s\033[0m\n' "$([ $fail -eq 0 ] && echo 'GATE GREEN' || echo 'GATE RED')"
exit $fail
