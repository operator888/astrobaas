#!/usr/bin/env node
/**
 * The shipped deploy artifacts: deploy.sh and its server half, the Dockerfile,
 * docker-compose.yml, the systemd unit, the nginx and Caddy configs and the
 * fail2ban examples.
 *
 * ## Why a test for config files
 *
 * Every defect this file pins was in a file no unit test read, and each one
 * looked fine until the day it was run:
 *
 *  - deploy.sh probed `http://127.0.0.1:<port>/healthz` — a placeholder nobody
 *    replaced. curl refused it on every deploy, `set -e` aborted, and the
 *    release clean-up after it never ran. It also chowned everything to a user
 *    the reference unit does not run as, and never created the directories the
 *    app writes to.
 *  - the Dockerfile copied a db.seed.json the project no longer ships, so
 *    `docker build` failed on a clean clone.
 *  - docker-compose published the app on every interface while telling the
 *    operator to trust X-Forwarded-For.
 *  - the unit had no descriptor limit, no stop timeout to match the app's
 *    drain, no heap ceiling, no PRIVATE_UPLOADS_DIR.
 *  - nginx answered its own rate limit with an opaque 503, had no gzip, no
 *    slow-client timeouts, no keep-alive upstream, and left /readyz public.
 *
 * The server half of deploy.sh is RUN here, against a temporary directory tree,
 * with systemctl, curl and chown replaced by recorders on PATH. Everything else
 * is read and checked against the property that matters.
 *
 * Syntax-level validation that needs the real tools is not done here — see
 * deploy/README.md for `nginx -t`, `caddy validate`, `systemd-analyze verify`
 * and `fail2ban-regex`.
 *
 * Run with:  node tests/deploy-artifacts.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readRepo } from './lib/load.mjs';

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-deploy-')));
// The real chmod, for the recorder below to pass through to: the modes it sets
// are what the permission checks read.
const REAL_CHMOD = ['/bin/chmod', '/usr/bin/chmod'].find((p) => existsSync(p));

/* ======================================================= shell syntax === */
for (const f of ['deploy.sh', 'deploy/remote-activate.sh']) {
  const r = spawnSync('bash', ['-n', path.join(ROOT, f)], { encoding: 'utf8' });
  check(`${f} parses (bash -n)${r.stderr ? `: ${r.stderr.trim()}` : ''}`, r.status === 0);
}

/* ================================================ deploy.sh, statically === */
{
  const sh = await readRepo('deploy.sh');
  const live = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  check('deploy.sh: no unreplaced <placeholder> left in a command', !/<port>|<slug>|<host>/.test(live));
  check('deploy.sh: no hard-coded site-$SLUG owner (the unit decides who runs the app)', !/site-\$SLUG/.test(live));
  check('deploy.sh: the server half is the checked file, fed on stdin',
    /ssh "\$SSH_HOST" "bash -s -- \$REMOTE_ARGS" < deploy\/remote-activate\.sh/.test(live));
  check('deploy.sh: remote arguments are quoted with %q (an empty one must not vanish)',
    /REMOTE_ARGS="\$\(printf '%q '/.test(live));
  check('deploy.sh: the maintenance page is built into the release', /build-maintenance-page\.mjs "\$STAGE\/maintenance\.html"/.test(live));
  // mktemp -d is 0700, and `rsync -a "$STAGE/" host:$RELEASE/` copies the
  // stage's mode onto the release root: a live site went down with 200/CHDIR.
  check('deploy.sh: THE BUG — the stage is opened to 0755 before rsync copies its mode onto the release root',
    /STAGE="\$\(mktemp -d\)"[\s\S]*?\nchmod 0755 "\$STAGE"\n[\s\S]*?\nrsync -a /.test(live));
  check('deploy.sh: refuses to ship a build without the precompiled mail test (a release cannot build it)',
    /npm run build[\s\S]*?test -f dist\/mail-test\.mjs \|\| \{[^}]*exit 1; \}[\s\S]*?cp -R dist "\$STAGE\/dist"/.test(live));
}

/* =========================================== remote-activate.sh, run === */

/** A fake server: recorders for systemctl, curl, chown, journalctl on PATH. */
async function fakeServer(name, { unitEnv = 'HOST=127.0.0.1 PORT=3002 TRUST_PROXY=1', unitUser = 'www-data', curlFailures = 2, dotenv } = {}) {
  const dir = path.join(tmp, name);
  const bin = path.join(dir, 'bin');
  const base = path.join(dir, 'var/www/cms-example-com');
  const log = path.join(dir, 'calls.log');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.join(base, 'releases'), { recursive: true });
  await fs.mkdir(path.join(base, 'shared'), { recursive: true });
  await fs.writeFile(path.join(base, 'shared/.env'), dotenv ?? 'AUTH_SECRET=x\n');
  await fs.writeFile(log, '');

  // Seven old releases; `current` points at the newest of them.
  const old = [];
  for (let i = 1; i <= 7; i++) {
    const r = path.join(base, 'releases', `2026090100000${i}`);
    await fs.mkdir(r, { recursive: true });
    old.push(r);
  }
  await fs.symlink(old.at(-1), path.join(base, 'current'));
  const release = path.join(base, 'releases', '20260916120000');
  await fs.mkdir(path.join(release, 'dist'), { recursive: true });
  await fs.writeFile(path.join(release, 'maintenance.html'), '<!doctype html><title>Back soon</title>');

  const stub = (file, body) => fs.writeFile(path.join(bin, file), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  await stub('systemctl', `
echo "systemctl $*" >> "${log}"
if [ "$1" = show ]; then
  case "$3" in
    User) printf '%s\\n' "${unitUser}" ;;
    Group) printf '%s\\n' "${unitUser}" ;;
    Environment) printf '%s\\n' "${unitEnv}" ;;
  esac
fi
exit 0`);
  await stub('curl', `
echo "curl $*" >> "${log}"
n=$(grep -c '^curl ' "${log}")
[ "$n" -gt ${curlFailures} ] && exit 0
exit 7`);
  await stub('chown', `echo "chown $*" >> "${log}"; exit 0`);
  // Recorded AND performed, so the order is checkable and the modes are real.
  await stub('chmod', `echo "chmod $*" >> "${log}"; exec ${REAL_CHMOD} "$@"`);
  await stub('journalctl', `echo "journalctl $*" >> "${log}"; exit 0`);
  return { dir, bin, base, log, old, release };
}

function activate(s, args, extraEnv = {}) {
  const r = spawnSync('bash', [path.join(ROOT, 'deploy/remote-activate.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, ASTROBAAS_READY_SLEEP: '0', ...extraEnv },
  });
  const calls = readOr(s.log).split('\n').filter(Boolean);
  return { ...r, calls };
}

// All three answer "no" for a missing path instead of throwing: a broken script
// must produce a ✗ line, not a crash that hides every check after it.
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const mode = (p) => { try { return (statSync(p).mode & 0o777).toString(8); } catch { return null; } };
const readOr = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

/* --- the ordinary deploy --- */
{
  const s = await fakeServer('ok');
  const r = activate(s, [s.base, s.release, 'cms-example-com', '', '', '5']);
  const t = (n, c) => check(`activate: ${n}`, c);
  t(`a good deploy exits 0${r.status ? ` (got ${r.status}: ${r.stderr.trim()})` : ''}`, r.status === 0);

  const curls = r.calls.filter((c) => c.startsWith('curl '));
  t('THE BUG — it probes a real port, read from the unit', curls.length > 0 && curls.every((c) => c.includes('http://127.0.0.1:3002/readyz')));
  t('...and nothing still says <port>', !r.calls.some((c) => c.includes('<port>')));
  t('it probes /readyz (ready), not /healthz (merely alive)', curls.every((c) => !c.includes('/healthz')));
  t('it keeps polling until ready (two failures, then success)', curls.length === 3);
  t('the restart comes before the first probe',
    r.calls.findIndex((c) => c === 'systemctl restart cms-example-com') !== -1
      && r.calls.findIndex((c) => c === 'systemctl restart cms-example-com') < r.calls.findIndex((c) => c.startsWith('curl ')));

  t('it creates shared/data/uploads', isDir(path.join(s.base, 'shared/data/uploads')));
  t('it creates shared/data/private-uploads, closed to others', isDir(path.join(s.base, 'shared/data/private-uploads'))
    && mode(path.join(s.base, 'shared/data/private-uploads')) === '750');
  t('it creates shared/maintenance and ships the page into it',
    readOr(path.join(s.base, 'shared/maintenance/maintenance.html')).includes('Back soon'));

  const chowns = r.calls.filter((c) => c.startsWith('chown '));
  t('the data directory goes to the user the UNIT runs as',
    chowns.includes(`chown -R www-data:www-data ${path.join(s.base, 'shared/data')}`));
  t('the code goes to root, readable by the app\'s group', chowns.includes(`chown -R root:www-data ${s.release}`));
  t('no site-<slug> owner anywhere', !chowns.some((c) => /site-/.test(c)));
  t('shared/ as a whole — and so shared/.env — is NOT handed to the app',
    !chowns.some((c) => c.endsWith(`${path.join(s.base, 'shared')}`) || c.includes('.env')));

  t('current now points at the new release', (await fs.readlink(path.join(s.base, 'current'))) === s.release);
  const left = (await fs.readdir(path.join(s.base, 'releases'))).sort();
  t('five releases are kept: the new one and the four newest before it',
    left.length === 5 && left.at(-1) === '20260916120000' && left[0] === '20260901000004');
  t('...including the one it replaced (the rollback target)', left.includes(path.basename(s.old.at(-1))));
}

/* --- THE BUG (a live site, 2026-09-18): a release that arrives 0700 --- */
{
  // What `rsync -a "$STAGE/" host:$RELEASE/` made of a `mktemp -d` stage. Owned
  // by root after the chown, the app user could not cd into it, and systemd
  // failed every start with 200/CHDIR. A directory and a file inside are closed
  // off as well, to prove the repair reaches in.
  const s = await fakeServer('mode0700', { curlFailures: 0 });
  const inner = path.join(s.release, 'dist', 'server');
  const file = path.join(inner, 'entry.mjs');
  await fs.mkdir(inner, { recursive: true });
  await fs.writeFile(file, 'export {};\n', { mode: 0o600 });
  await fs.chmod(inner, 0o700);
  await fs.chmod(s.release, 0o700);
  const r = activate(s, [s.base, s.release, 'cms-example-com']);
  const bits = (p) => { try { return statSync(p).mode & 0o777; } catch { return 0; } };

  check(`activate: THE BUG — a release that arrives 0700 is made enterable (0755)${r.status ? ` (exit ${r.status}: ${r.stderr.trim()})` : ''}`,
    r.status === 0 && mode(s.release) === '755');
  check('activate: ...directories inside become group-traversable, files group-readable',
    (bits(inner) & 0o050) === 0o050 && (bits(file) & 0o040) === 0o040);
  check('activate: ...and nothing becomes group-writable (the app must not rewrite its own code)',
    [s.release, inner, file].every((p) => (bits(p) & 0o020) === 0));
  const opened = r.calls.indexOf(`chmod 0755 ${s.release}`);
  check('activate: ...before the service is restarted onto it',
    opened !== -1 && opened < r.calls.indexOf('systemctl restart cms-example-com'));
}

/* --- a release built under umask 002 arrives GROUP-WRITABLE --- */
{
  // The case above only ever starts from 0600/0700, so "nothing becomes
  // group-writable" held there without the repair removing anything. A build
  // machine with umask 002 — the Debian/Ubuntu default for a user with their
  // own group — gives 0775 directories and 0664 files, and rsync -a keeps them.
  // `chmod -R g+rX` only ADDS bits: those stayed group-writable, and after the
  // chown to root:<run group> the app could rewrite its own code.
  const s = await fakeServer('umask002', { curlFailures: 0 });
  const inner = path.join(s.release, 'dist', 'server');
  const file = path.join(inner, 'entry.mjs');
  await fs.mkdir(inner, { recursive: true });
  await fs.writeFile(file, 'export {};\n');
  await fs.chmod(file, 0o664);
  await fs.chmod(inner, 0o775);
  await fs.chmod(s.release, 0o775);
  const r = activate(s, [s.base, s.release, 'cms-example-com']);
  const bits = (p) => { try { return statSync(p).mode & 0o777; } catch { return 0; } };
  const modes = [s.release, inner, file].map((p) => bits(p).toString(8)).join(' ');
  check(`activate: a release that arrives group-writable (0775 dirs, 0664 files) loses group-write (now ${modes})${r.status ? ` (exit ${r.status}: ${r.stderr.trim()})` : ''}`,
    r.status === 0 && [s.release, inner, file].every((p) => (bits(p) & 0o020) === 0));
  check('activate: ...and stays readable and traversable by the group',
    (bits(inner) & 0o050) === 0o050 && (bits(file) & 0o040) === 0o040);
}

/* --- the port from shared/.env when the unit does not set it --- */
{
  const s = await fakeServer('dotenv', { unitEnv: 'HOST=127.0.0.1', dotenv: 'AUTH_SECRET=x\nPORT="3005"\n', curlFailures: 0 });
  const r = activate(s, [s.base, s.release, 'cms-example-com']);
  check('activate: with no PORT in the unit, shared/.env supplies it',
    r.status === 0 && r.calls.some((c) => c.includes('http://127.0.0.1:3005/readyz')));
}

/* --- explicit arguments win --- */
{
  const s = await fakeServer('explicit', { curlFailures: 0 });
  const r = activate(s, [s.base, s.release, 'cms-example-com', '4000', 'site-shop', '3']);
  check('activate: an explicit port wins over the unit', r.calls.some((c) => c.includes('http://127.0.0.1:4000/readyz')));
  check('activate: an explicit run-user wins over the unit',
    r.calls.includes(`chown -R site-shop:www-data ${path.join(s.base, 'shared/data')}`));
  check('activate: keep=3 keeps three', (await fs.readdir(path.join(s.base, 'releases'))).length === 3);
}

/* --- the unit's User= is what decides, not a default --- */
{
  const s = await fakeServer('unituser', { unitUser: 'shopuser', curlFailures: 0 });
  const r = activate(s, [s.base, s.release, 'cms-example-com']);
  check('activate: with no run-user argument, the owner is the unit\'s User= (not a guess)',
    r.status === 0 && r.calls.includes(`chown -R shopuser:shopuser ${path.join(s.base, 'shared/data')}`));
}

/* --- the release being replaced survives pruning, however old it is --- */
{
  const s = await fakeServer('oldcurrent', { curlFailures: 0 });
  // `current` points at the OLDEST release — e.g. after a manual rollback.
  await fs.rm(path.join(s.base, 'current'));
  await fs.symlink(s.old[0], path.join(s.base, 'current'));
  const r = activate(s, [s.base, s.release, 'cms-example-com', '', '', '3']);
  const left = await fs.readdir(path.join(s.base, 'releases'));
  check('activate: the release it replaced is never pruned, even outside the newest N (the rollback target)',
    r.status === 0 && left.includes(path.basename(s.old[0])) && left.includes('20260916120000'));
  check('activate: ...while the rest beyond N are', left.length === 4);
}

/* --- no port anywhere: refuse BEFORE touching anything --- */
{
  const s = await fakeServer('noport', { unitEnv: 'HOST=127.0.0.1' });
  const r = activate(s, [s.base, s.release, 'cms-example-com']);
  check('activate: no port anywhere is a failure with a reason', r.status !== 0 && /Cannot tell which port/.test(r.stderr));
  check('activate: ...before the symlink is flipped or anything restarted',
    (await fs.readlink(path.join(s.base, 'current'))) === s.old.at(-1)
      && !r.calls.some((c) => c.startsWith('systemctl restart')));
}

/* --- never ready: fail loudly, keep the old releases, say how to roll back --- */
{
  const s = await fakeServer('notready', { curlFailures: 1000 });
  const r = activate(s, [s.base, s.release, 'cms-example-com'], { ASTROBAAS_READY_TRIES: '3' });
  check('activate: a release that never becomes ready fails the deploy', r.status === 1);
  check('activate: ...after exactly the configured number of probes', r.calls.filter((c) => c.startsWith('curl ')).length === 3);
  check('activate: ...printing the rollback command for the previous release',
    r.stderr.includes('To roll back') && r.stderr.includes(s.old.at(-1)));
  check('activate: ...and pruning nothing, so the rollback target still exists',
    (await fs.readdir(path.join(s.base, 'releases'))).length === 8);
}

/* ============================================================ Dockerfile === */
{
  const df = await readRepo('Dockerfile');
  const produced = new Set(['dist', 'node_modules']); // written by the build stage itself
  const dockerignore = (await readRepo('.dockerignore')).split('\n').map((l) => l.trim()).filter(Boolean);
  const copies = [...df.matchAll(/^COPY --from=build \/app\/(\S+)/gm)].map((m) => m[1]);
  check('Dockerfile: copies from the build stage', copies.length >= 4);
  for (const c of copies) {
    const ok = produced.has(c) || (existsSync(path.join(ROOT, c)) && !dockerignore.includes(c));
    check(`Dockerfile: COPY --from=build /app/${c} exists in a clean build context`, ok);
  }
  const env = Object.fromEntries([...df.matchAll(/^ENV (\w+)=(\S+)/gm)].map((m) => [m[1], m[2]]));
  const volume = df.match(/^VOLUME \["([^"]+)"\]/m)?.[1];
  for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
    check(`Dockerfile: the image carries ${f} (it bundles LGPL libvips)`, copies.includes(f));
  }
  check('Dockerfile: declares the data volume', volume === '/app/data');
  for (const k of ['DB_PATH', 'UPLOADS_DIR', 'PRIVATE_UPLOADS_DIR']) {
    check(`Dockerfile: ${k} is inside the volume, so it survives a rebuild`, (env[k] ?? '').startsWith(`${volume}/`));
  }
  check('Dockerfile: private uploads are not under the public uploads dir',
    !(env.PRIVATE_UPLOADS_DIR ?? '').startsWith(`${env.UPLOADS_DIR}/`));
  check('Dockerfile: the drain fits inside `docker stop`\'s default 10 s',
    Number(env.SHUTDOWN_TIMEOUT_MS) > 0 && Number(env.SHUTDOWN_TIMEOUT_MS) < 10_000);

  // The image, like a deploy.sh release, has no src/ to compile the mail test
  // from, so the build has to leave it in dist/. The Dockerfile ran the astro
  // commands by hand, which would have skipped it.
  const buildScript = JSON.parse(await readRepo('package.json')).scripts.build ?? '';
  check('package.json: `npm run build` compiles the mail test into dist/', /\bnode scripts\/build-mail-test\.mjs\b/.test(buildScript));
  check('Dockerfile: builds with `npm run build`, so the image carries dist/mail-test.mjs',
    /^RUN npm run build\s*$/m.test(df) && !/^RUN npx astro build/m.test(df));
}

/* ======================================================= docker-compose === */
{
  const yml = await readRepo('docker-compose.yml');
  const live = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  // The file shipped as invalid YAML: an unquoted `${AUTH_SECRET:?… with: …}`
  // has ": " inside a plain scalar, which YAML forbids ("mapping values are not
  // allowed in this context"), so `docker compose up` never got as far as
  // reading it. No YAML parser here (no new dependencies), so the rule itself:
  // a plain (unquoted) value may not contain ": ".
  const badScalars = live.split('\n').filter((l) => {
    const m = l.match(/^\s*(?:-\s+)?[\w.-]+:\s+(.+)$/);
    return m && !/^["'[{|>]/.test(m[1]) && /:\s/.test(m[1]);
  });
  check(`compose: is valid YAML — no unquoted value containing ": "${badScalars.length ? ` (${badScalars[0].trim()})` : ''}`,
    badScalars.length === 0);
  const ports = [...live.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]).filter((p) => /:\d+$/.test(p));
  check('compose: publishes a port', ports.length >= 1);
  check('compose: THE FIX — every published port is bound to loopback', ports.every((p) => p.startsWith('127.0.0.1:')));
  const grace = live.match(/stop_grace_period:\s*(\d+)s/)?.[1];
  const drain = live.match(/SHUTDOWN_TIMEOUT_MS:\s*"?(\d+)"?/)?.[1];
  check('compose: the stop grace period is longer than the drain', !!grace && !!drain && Number(grace) * 1000 > Number(drain));
  check('compose: runs an init as PID 1', /^\s*init:\s*true\s*$/m.test(live));
}

/* ========================================================= systemd unit === */
{
  const unit = await readRepo('deploy/systemd/astrobaas.service');
  const section = (name) => {
    const m = unit.match(new RegExp(`^\\[${name}\\]\\n([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm'));
    return (m?.[1] ?? '').split('\n').filter((l) => l && !l.startsWith('#'));
  };
  const svc = section('Service');
  const val = (k) => svc.filter((l) => l.startsWith(`${k}=`)).map((l) => l.slice(k.length + 1));
  const envs = Object.fromEntries(val('Environment').map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  const mb = (s) => { const m = String(s).match(/^(\d+)([KMG])?$/); return m ? Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024 }[m[2]] ?? 1 / 1048576) : NaN; };

  check('unit: runs as a named user (deploy.sh reads it)', val('User').length === 1);
  check('unit: states its PORT (deploy.sh reads it)', /^\d+$/.test(envs.PORT ?? ''));
  check('unit: LimitNOFILE is raised well above the 1024 default', Number(val('LimitNOFILE')[0]) >= 16_384);
  const stop = Number(val('TimeoutStopSec')[0]);
  check('unit: TimeoutStopSec is set, and longer than the app\'s drain',
    stop > 0 && stop * 1000 > Number(envs.SHUTDOWN_TIMEOUT_MS ?? 25_000));
  check('unit: ...and SHUTDOWN_TIMEOUT_MS is stated beside it', Number(envs.SHUTDOWN_TIMEOUT_MS) > 0);
  const heap = Number((envs.NODE_OPTIONS ?? '').match(/--max-old-space-size=(\d+)/)?.[1]);
  const high = mb(val('MemoryHigh')[0]);
  const max = mb(val('MemoryMax')[0]);
  check('unit: NODE_OPTIONS sets a heap ceiling', heap > 0);
  check('unit: ...below MemoryHigh and at most 3/4 of MemoryMax (native memory needs the rest)',
    heap < high && heap <= max * 0.75);

  const rw = val('ReadWritePaths').flatMap((l) => l.split(/\s+/));
  for (const k of ['DB_PATH', 'UPLOADS_DIR', 'PRIVATE_UPLOADS_DIR']) {
    check(`unit: ${k} is set and writable under ProtectSystem=strict`,
      !!envs[k] && rw.some((p) => envs[k].startsWith(`${p}/`)));
  }
  check('unit: private uploads are not under the public uploads dir',
    !!envs.PRIVATE_UPLOADS_DIR && !envs.PRIVATE_UPLOADS_DIR.startsWith(`${envs.UPLOADS_DIR}/`));
  check('unit: ...and it is where deploy/remote-activate.sh creates it',
    (await readRepo('deploy/remote-activate.sh')).includes('shared/data/private-uploads')
      && envs.PRIVATE_UPLOADS_DIR?.endsWith('/shared/data/private-uploads'));
}

/* ================================================================ nginx === */
const vhostRaw = await readRepo('deploy/nginx/astrobaas.conf');
const zonesRaw = await readRepo('deploy/nginx/astrobaas-zones.conf');
const strip = (s) => s.replace(/#[^\n]*/g, '');
{
  const vhost = strip(vhostRaw);
  const zones = strip(zonesRaw);

  // The TLS server block, brace-counted.
  const tlsStart = vhost.search(/server\s*\{[^{}]*listen 443/);
  let depth = 0;
  let i = vhost.indexOf('{', tlsStart);
  const open = i;
  for (; i < vhost.length; i++) {
    if (vhost[i] === '{') depth++;
    else if (vhost[i] === '}' && --depth === 0) break;
  }
  const tls = vhost.slice(open + 1, i);
  // Server-level = the TLS block with every nested block removed.
  let serverLevel = tls;
  while (/\{[^{}]*\}/.test(serverLevel)) serverLevel = serverLevel.replace(/[^;{}]*\{[^{}]*\}/g, '');
  const has = (re) => re.test(serverLevel);

  check('nginx: edge rejections answer 429, not 503', has(/^\s*limit_req_status 429;/m) && has(/^\s*limit_conn_status 429;/m));
  check('nginx: gzip is on, for JSON and JS too', has(/^\s*gzip on;/m) && has(/gzip_types[^;]*application\/json/) && has(/gzip_types[^;]*application\/javascript/));
  check('nginx: slow-header clients are cut off', has(/^\s*client_header_timeout \d+s;/m));
  check('nginx: keepalive_timeout, send_timeout and header buffers are explicit',
    has(/^\s*keepalive_timeout \d+s;/m) && has(/^\s*send_timeout \d+s;/m) && has(/^\s*large_client_header_buffers \d+ \d+k;/m));
  check('nginx: server_tokens off', has(/^\s*server_tokens off;/m));
  const protocols = serverLevel.match(/ssl_protocols ([^;]+);/)?.[1] ?? '';
  check('nginx: TLS 1.2+ only', /TLSv1\.2/.test(protocols) && /TLSv1\.3/.test(protocols) && !/TLSv1(\.[01])?(\s|$)/.test(protocols));

  const upstream = vhost.match(/upstream\s+(\w+)\s*\{([^}]*)\}/);
  check('nginx: an upstream block with keep-alive connections', !!upstream && /keepalive \d+;/.test(upstream[2]));
  check('nginx: ...with HTTP/1.1 and an empty Connection header at server level, or keep-alive does nothing',
    has(/^\s*proxy_http_version 1\.1;/m) && has(/^\s*proxy_set_header Connection "";/m));
  const passes = [...vhost.matchAll(/proxy_pass\s+([^;]+);/g)].map((m) => m[1]);
  check('nginx: every proxy_pass goes through the upstream',
    passes.length > 5 && passes.every((p) => p === `http://${upstream?.[1]}`));

  // The inheritance trap: one proxy_set_header in a location drops all the
  // server-level ones for that location.
  const locBodies = [...tls.matchAll(/location\s+[^{]+\{([^{}]*)\}/g)].map((m) => m[1]);
  check('nginx: no location sets its own proxy_set_header (it would silently drop Host and X-Forwarded-*)',
    locBodies.length > 5 && locBodies.every((b) => !/proxy_set_header/.test(b)));
  check('nginx: the forwarded headers are all set once, at server level',
    ['Host $host', 'X-Real-IP $remote_addr', 'X-Forwarded-For $proxy_add_x_forwarded_for', 'X-Forwarded-Proto $scheme']
      .every((h) => serverLevel.includes(`proxy_set_header ${h};`)));

  const loc = (spec) => tls.match(new RegExp(`location\\s+${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
  check('nginx: the backup restore is rate limited', /limit_req zone=\w+/.test(loc('= /api/backup/import')));
  check('nginx: the WordPress import is rate limited', /limit_req zone=\w+/.test(loc('= /api/import/wordpress')));
  check('nginx: /readyz is loopback-only', /allow 127\.0\.0\.1;/.test(loc('= /readyz')) && /deny all;/.test(loc('= /readyz')));
  check('nginx: /healthz stays public but rate limited', /limit_req zone=\w+/.test(loc('= /healthz')) && !/deny all/.test(loc('= /healthz')));
  check('nginx: /metrics is loopback-only', /deny all;/.test(loc('= /metrics')) && /allow 127\.0\.0\.1;/.test(loc('= /metrics')));
  const intercepted = [...tls.matchAll(/error_page((?:\s+\d{3})+)\s/g)].flatMap((m) => m[1].trim().split(/\s+/));
  check('nginx: the maintenance page is served as 503 when the app is down',
    /error_page 502 504 =503 \/maintenance\.html;/.test(loc('/')));
  check('nginx: ...and never intercepts the app\'s own 503 (maintenance, health, drain)',
    intercepted.length > 0 && !intercepted.includes('503'));

  const referenced = new Set([...vhost.matchAll(/limit_req zone=(\w+)/g), ...vhost.matchAll(/limit_conn (\w+) \d+/g)].map((m) => m[1]));
  const declared = new Set([...zones.matchAll(/zone=(\w+):/g)].map((m) => m[1]));
  check(`nginx: every zone the vhost uses is declared in the zones file (${[...referenced].join(', ')})`,
    referenced.size >= 3 && [...referenced].every((z) => declared.has(z)));
  check('nginx: the zones file sets nothing that could duplicate an nginx.conf directive',
    !/^\s*(server_tokens|limit_req_status|limit_conn_status|gzip)\b/m.test(zones));

  // Guidance that must exist even though it is commented out.
  check('nginx: CDN real-IP guidance is there, commented',
    /#\s*set_real_ip_from /.test(vhostRaw) && /#\s*real_ip_header CF-Connecting-IP;/.test(vhostRaw));
  check('nginx: an admin IP-restriction example is there, commented',
    /#\s*location \^~ \/admin \{/.test(vhostRaw) && /#\s*deny all;/.test(vhostRaw));
}

/* ================================================================ Caddy === */
{
  const raw = await readRepo('deploy/caddy/Caddyfile');
  const live = raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const ops = live.match(/@(\w+) path ([^\n]*\/metrics[^\n]*)\n\s*handle @\1 \{([\s\S]*?)\n\t\}/);
  check('caddy: /metrics has its own handle', !!ops);
  check('caddy: ...that refuses anyone but loopback',
    !!ops && /not remote_ip 127\.0\.0\.1 ::1/.test(ops[3]) && /respond @\w+ 403/.test(ops[3]));
  check('caddy: /readyz is restricted the same way', !!ops && /\/readyz/.test(ops[2]));
  check('caddy: ...and that handle comes before the catch-all', !!ops && live.indexOf(ops[0]) < live.search(/\n\thandle \{/));

  const errs = live.match(/handle_errors \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
  check('caddy: a maintenance page for when the app is down', /maintenance\.html/.test(errs) && /shared\/maintenance/.test(errs));
  check('caddy: ...served as 503, never 200', /file_server \{\s*status 503\s*\}/.test(errs));
  check('caddy: ...only for Caddy\'s own 502/504, not the app\'s deliberate 503',
    /\{err\.status_code\} in \[502, 504\]/.test(errs) && !/503\]/.test(errs));

  check('caddy: rate limiting is addressed — core Caddy has none, and the module is named',
    /core Caddy has none/i.test(raw) && /github\.com\/mholt\/caddy-ratelimit/.test(raw));
  check('caddy: trusted_proxies guidance for a CDN, with the X-Forwarded-For fix',
    /#\s*trusted_proxies static /.test(raw) && /#\s*header_up X-Forwarded-For \{client_ip\}/.test(raw));
}

/* ============================================================= fail2ban === */
{
  const filter = await readRepo('deploy/fail2ban/filter.d/astrobaas-429.conf');
  const jail = await readRepo('deploy/fail2ban/jail.d/astrobaas.local');
  const failregex = filter.match(/^failregex\s*=\s*(.+)$/m)?.[1];
  check('fail2ban: the filter has a failregex', !!failregex);

  // fail2ban's own rules, approximated: <HOST> is an address, and the date
  // found in the line is cut out before matching (hence the empty brackets).
  const re = new RegExp(failregex
    .replace('<HOST>', '(?<host>[0-9a-fA-F:.]+)')
    .replace(/\(\?P</g, '(?<'));
  const prep = (line) => line.replace(/\[\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}\]/, '[]');
  const hit = (line) => prep(line).match(re)?.groups?.host;
  const L = (ip, status, req = 'GET /api/products HTTP/2.0') => `${ip} - - [16/Sep/2026:12:00:00 +0200] "${req}" ${status} 97 "-" "curl/8.4"`;
  check('fail2ban: a 429 line is matched, and the address extracted', hit(L('203.0.113.9', 429)) === '203.0.113.9');
  check('fail2ban: ...IPv6 too', hit(L('2001:db8::7', 429)) === '2001:db8::7');
  check('fail2ban: a 200 is not', hit(L('203.0.113.9', 200)) === undefined);
  check('fail2ban: a 503 is NOT (maintenance and deploys hit everyone at once)', hit(L('203.0.113.9', 503)) === undefined);
  check('fail2ban: a 4290-byte 200 is not mistaken for a 429', hit(`203.0.113.9 - - [16/Sep/2026:12:00:00 +0200] "GET / HTTP/1.1" 200 4290 "-" "x"`) === undefined);
  check('fail2ban: a request path containing " 429 " cannot forge a match',
    hit(`203.0.113.9 - - [16/Sep/2026:12:00:00 +0200] "GET /x 429 1 HTTP/1.1" 200 5 "-" "x"`) === undefined);

  check('fail2ban: the jail uses this filter', /^filter\s*=\s*astrobaas-429\s*$/m.test(jail));
  const accessLog = vhostRaw.match(/access_log (\S+);/)?.[1];
  const errorLog = vhostRaw.match(/error_log\s+(\S+);/)?.[1];
  check('fail2ban: ...on the access log the vhost writes', new RegExp(`logpath\\s*=\\s*${accessLog?.replace(/\./g, '\\.')}`).test(jail));
  check('fail2ban: the stock limit_req filter reads the vhost\'s error log', jail.includes(`logpath  = ${errorLog}`));
  const zonesNamed = [...jail.matchAll(/ngx_limit_req_zones="([^"]+)"/g)].flatMap((m) => m[1].split('|'));
  const declared = new Set([...strip(zonesRaw).matchAll(/zone=(\w+):/g)].map((m) => m[1]));
  check('fail2ban: every zone it watches exists', zonesNamed.length > 0 && zonesNamed.every((z) => declared.has(z)));
  check('fail2ban: behind Cloudflare, the ban has to happen at Cloudflare — and the file says so',
    /cloudflare/i.test(jail) && /real-IP/.test(jail));
}

/* ================================================================= docs === */
{
  const readme = await readRepo('deploy/README.md');
  const hard = readme.slice(readme.search(/^## Hardening/m));
  check('docs: deploy/README.md has a Hardening section', /^## Hardening/m.test(readme));
  for (const [what, re] of [
    ['Cloudflare real IP', /CF-Connecting-IP|set_real_ip_from/],
    ['firewalling the origin to the CDN', /ufw|nftables|iptables/],
    ['restricting admin access', /\/admin/],
    ['fail2ban', /fail2ban/],
    ['CrowdSec', /CrowdSec/],
    ['backups kept outside the app', /[Bb]ackup/],
    ['uptime monitoring', /[Uu]ptime/],
  ]) check(`docs: the hardening section covers ${what}`, re.test(hard));
  check('docs: it points at the example fail2ban files', hard.includes('deploy/fail2ban/'));
  check('docs: the layout lists private-uploads', readme.includes('shared/data/private-uploads/'));
  // Step 5b ran scripts/mail-test.mjs inside `current` — a path no release has.
  // The operator-facing copy of that command moved from README.md to
  // docs/EMAIL.md when the README was trimmed; the guard follows the command,
  // not the file it used to live in.
  for (const [name, doc] of [['deploy/README.md', readme], ['docs/EMAIL.md', await readRepo('docs/EMAIL.md')]]) {
    const inRelease = [...doc.matchAll(/WorkingDirectory=\/var\/www\/<site>\/current[\s\S]*?\/usr\/bin\/node (\S+)/g)].map((m) => m[1]);
    check(`docs: ${name} runs the release's own mail test (dist/mail-test.mjs), not a script a release does not have`,
      inRelease.length > 0 && inRelease.every((f) => f === 'dist/mail-test.mjs'));
  }
  check('docs: validation commands for the configs are given',
    /nginx -t/.test(readme) && /caddy validate/.test(readme) && /systemd-analyze verify/.test(readme) && /fail2ban-regex/.test(readme));


  const env = await readRepo('.env.example');
  check('.env.example documents PRIVATE_UPLOADS_DIR', /PRIVATE_UPLOADS_DIR=/.test(env));
  check('.env.example documents SHUTDOWN_TIMEOUT_MS', /SHUTDOWN_TIMEOUT_MS=/.test(env));
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
