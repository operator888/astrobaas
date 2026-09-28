#!/usr/bin/env node
/**
 * Tests for the `astrobaas` CLI (bin/astrobaas.mjs). Spawns the real bin as a
 * subprocess (the way a user/npx would run it) in a throwaway temp dir, so we
 * exercise the shipped artifact, not a re-import.
 *
 * Run with:  node tests/cli.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'astrobaas.mjs');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/** Run the bin with args in `cwd`; return { status, stdout, stderr }. */
function run(args, cwd = process.cwd()) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'astrobaas-cli-'));
}

// ---- version ----
{
  const { status, stdout } = run(['version']);
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  check('version exits 0', status === 0);
  check('version prints package.json version', stdout.trim() === pkg.version);
}

// ---- secret ----
{
  const { status, stdout } = run(['secret']);
  check('secret exits 0', status === 0);
  check('secret is 64 hex chars (32 bytes)', /^[0-9a-f]{64}$/.test(stdout.trim()));
  const second = run(['secret']).stdout.trim();
  check('secret differs each run', stdout.trim() !== second);
}

// ---- help / no-args ----
{
  const help = run(['--help']);
  check('--help exits 0', help.status === 0);
  check('--help mentions init/secret/setup', /init/.test(help.stdout) && /secret/.test(help.stdout) && /setup/.test(help.stdout));
  const none = run([]);
  check('no args shows help (exit 0)', none.status === 0 && /Usage:/.test(none.stdout));
}

// ---- unknown command ----
{
  const { status, stdout, stderr } = run(['frobnicate']);
  check('unknown command exits non-zero', status === 1);
  check('unknown command still prints help', /Usage:/.test(stdout) || /Usage:/.test(stderr));
}

// ---- init ----
{
  const dir = mkTmp();
  try {
    const first = run(['init'], dir);
    const envPath = path.join(dir, '.env');
    check('init exits 0', first.status === 0);
    check('init creates a .env', fs.existsSync(envPath));
    const body = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const m = body.match(/^AUTH_SECRET=([0-9a-f]+)$/m);
    check('init writes a 64-hex AUTH_SECRET', !!m && m[1].length === 64);
    check('init carries documented vars from .env.example', /CORS_ORIGINS|DATABASE_URL/.test(body));

    // Second init must refuse without --force.
    const second = run(['init'], dir);
    check('init refuses to clobber existing .env', second.status === 1);
    check('init suggests --force/secret on refusal', /force|secret/i.test(second.stderr));

    // --force rotates the secret.
    const before = fs.readFileSync(envPath, 'utf8').match(/^AUTH_SECRET=(.+)$/m)?.[1];
    const forced = run(['init', '--force'], dir);
    const after = fs.readFileSync(envPath, 'utf8').match(/^AUTH_SECRET=(.+)$/m)?.[1];
    check('init --force exits 0', forced.status === 0);
    check('init --force rotates the secret', !!before && !!after && before !== after);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- scaffolding: plugin / manifest / theme ----
{
  const dir = mkTmp();
  try {
    // A scaffolded manifest must pass the SAME validator the install path uses.
    const gen = run(['plugin', 'manifest', 'demo-thing'], dir);
    check('plugin manifest exits 0', gen.status === 0);
    check('plugin manifest writes the file', fs.existsSync(path.join(dir, 'demo-thing.manifest.json')));
    const val = run(['plugin', 'validate', 'demo-thing.manifest.json'], dir);
    check('scaffolded manifest VALIDATES (round-trip)', val.status === 0 && /valid/.test(val.stdout));

    // Code plugin + theme land in the right place with the right id.
    const p = run(['plugin', 'new', 'demo-plug'], dir);
    check('plugin new exits 0', p.status === 0);
    const pluginSrc = fs.existsSync(path.join(dir, 'src/plugins/demo-plug/index.ts'))
      ? fs.readFileSync(path.join(dir, 'src/plugins/demo-plug/index.ts'), 'utf8') : '';
    check('plugin new scaffolds src/plugins/<id>/index.ts', !!pluginSrc);
    check('scaffolded plugin carries the id + core import', /id: 'demo-plug'/.test(pluginSrc) && /astrobaas\/core/.test(pluginSrc));
    check('plugin new prints the registration step', /src\/plugins\/index\.ts/.test(p.stdout));

    const t = run(['theme', 'new', 'demo-theme'], dir);
    check('theme new exits 0', t.status === 0);
    check('theme new scaffolds index + a slot override',
      fs.existsSync(path.join(dir, 'src/themes/demo-theme/index.ts')) &&
      fs.existsSync(path.join(dir, 'src/themes/demo-theme/Header.astro')));

    // Guardrails.
    const bad = run(['plugin', 'new', 'Bad Id'], dir);
    check('rejects a non-kebab-case id', bad.status === 1 && /Invalid id/.test(bad.stderr));
    const clash = run(['plugin', 'new', 'demo-plug'], dir);
    check('refuses to clobber without --force', clash.status === 1 && /Refusing to overwrite/.test(clash.stderr));
    const forced = run(['plugin', 'new', 'demo-plug', '--force'], dir);
    check('--force overwrites', forced.status === 0);

    const noId = run(['plugin', 'new'], dir);
    check('requires an id', noId.status === 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * The verbs that need a running site
 * ------------------------------------------------------------------ */
{
  // No site is running under `npm run test:unit`, so what is asserted here is
  // that the failure is a SENTENCE rather than a stack trace — an unreachable
  // server is the commonest way these are used wrongly, and a trace tells an
  // operator nothing about which of the two things to fix.
  const env = { ...process.env, ASTROBAAS_URL: 'http://127.0.0.1:9', ASTROBAAS_KEY: '' };
  const offline = (args) => spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', timeout: 30000, env,
  });

  const types = offline(['content', 'types']);
  check('content types fails cleanly when the site is unreachable',
    types.status === 1 && /Could not reach/.test(types.stderr) && !/at Object|node:internal/.test(types.stderr));
  check('...and says an API key is probably needed', /ASTROBAAS_KEY/.test(types.stderr));

  const noType = offline(['content', 'list']);
  check('content list without a type prints usage', noType.status === 1 && /Usage/.test(noType.stderr));

  const badSub = offline(['content', 'nonsense']);
  check('an unknown content subcommand prints usage', badSub.status === 1 && /Usage/.test(badSub.stderr));

  const userBad = offline(['user', 'create']);
  check('user create points at the OFFLINE tools rather than pretending',
    userBad.status === 1 && /setup|reset-password/.test(userBad.stderr));

  const help = spawnSync(process.execPath, [BIN, 'help'], { encoding: 'utf8' });
  check('help lists the new verbs',
    /content types/.test(help.stdout) && /backup export/.test(help.stdout) && /user list/.test(help.stdout));
  check('help lists clone', /clone/.test(help.stdout));

  // CLONE — the command that can destroy a site if the two URLs are the wrong
  // way round. Every guard is asserted, because none of them is recoverable.
  const cloneNoArgs = offline(['clone']);
  check('clone without arguments prints usage', cloneNoArgs.status === 1 && /Usage/.test(cloneNoArgs.stderr));

  const cloneSame = offline(['clone', 'https://a.example', 'https://a.example/', '--yes']);
  check('clone REFUSES when source and target are the same site',
    cloneSame.status === 1 && /same site/.test(cloneSame.stderr));

  const cloneUnconfirmed = offline(['clone', 'https://a.example', 'https://b.example']);
  check('clone refuses without --yes, and names the TARGET first',
    cloneUnconfirmed.status === 1
    && /REPLACES the content of/.test(cloneUnconfirmed.stderr)
    && cloneUnconfirmed.stderr.indexOf('b.example') < cloneUnconfirmed.stderr.indexOf('a.example'));
}

/* ------------------------------------------------------------------ *
 * `create` — a new project from a release archive
 * ------------------------------------------------------------------ */

/**
 * The real source is GitHub; ASTROBAAS_CREATE_SOURCE points it at a local
 * archive built here, shaped like GitHub's (one top-level folder), so this runs
 * without a network. The archive's .env.example carries a marker, which proves
 * the .env is written from the NEW project's template, not the CLI's.
 */
{
  const work = mkTmp();
  const runIn = (args, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: work, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...extraEnv },
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const makeArchive = (name, files) => {
    const src = path.join(work, `${name}-src`);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(src, 'astrobaas-9.9.9', rel)), { recursive: true });
      fs.writeFileSync(path.join(src, 'astrobaas-9.9.9', rel), body);
    }
    const out = path.join(work, `${name}.tar.gz`);
    spawnSync('tar', ['-czf', out, '-C', src, 'astrobaas-9.9.9']);
    return out;
  };
  try {
    const good = makeArchive('good', {
      'package.json': '{"name":"astrobaas"}',
      'scripts/setup.mjs': '',
      '.env.example': 'AUTH_SECRET=\nCREATE_MARKER=from-the-project\n',
    });
    const made = runIn(['create', 'my-site'], { ASTROBAAS_CREATE_SOURCE: good });
    const site = path.join(work, 'my-site');
    check('create exits 0', made.status === 0);
    check('create unpacks WITHOUT the archive\'s top-level folder',
      fs.existsSync(path.join(site, 'package.json')) && !fs.existsSync(path.join(site, 'astrobaas-9.9.9')));
    const env = fs.existsSync(path.join(site, '.env')) ? fs.readFileSync(path.join(site, '.env'), 'utf8') : '';
    check('create writes a .env with a 64-hex AUTH_SECRET', /^AUTH_SECRET=[0-9a-f]{64}$/m.test(env));
    check('create builds the .env from the NEW project\'s .env.example', /CREATE_MARKER=from-the-project/.test(env));
    check('create tells you to cd into it first', /cd my-site/.test(made.stdout) && /npm install/.test(made.stdout));

    const again = runIn(['create', 'my-site'], { ASTROBAAS_CREATE_SOURCE: good });
    check('create REFUSES a folder that is not empty', again.status === 1 && /not empty/.test(again.stderr));
    check('...and leaves what was there alone', fs.existsSync(path.join(site, '.env')));

    const junk = makeArchive('junk', { 'README.md': 'not a project' });
    const bad = runIn(['create', 'junk-site'], { ASTROBAAS_CREATE_SOURCE: junk });
    check('create refuses an archive that is not an AstroBaaS project',
      bad.status === 1 && /not an AstroBaaS project/.test(bad.stderr));
    check('...and removes the half-made folder, so a retry is not "not empty"',
      !fs.existsSync(path.join(work, 'junk-site')));

    fs.mkdirSync(path.join(work, 'empty-dir'));
    const missing = runIn(['create', 'empty-dir'], { ASTROBAAS_CREATE_SOURCE: path.join(work, 'nope.tar.gz') });
    check('create fails cleanly when the archive cannot be read',
      missing.status === 1 && /Could not create/.test(missing.stderr));
    check('...and keeps a folder that existed before (empty) rather than deleting it',
      fs.existsSync(path.join(work, 'empty-dir')) && fs.readdirSync(path.join(work, 'empty-dir')).length === 0);

    const noDir = runIn(['create']);
    check('create without a directory prints usage', noDir.status === 1 && /Usage: astrobaas create/.test(noDir.stderr));
    check('help lists create', /create <dir>/.test(run(['--help']).stdout));

    // `init` outside a project used to print "npm install, npm run setup" —
    // commands that cannot work there. It now points at `create`.
    const outside = path.join(work, 'outside');
    fs.mkdirSync(outside);
    const initOut = run(['init'], outside);
    check('init outside a project still writes the .env', initOut.status === 0 && fs.existsSync(path.join(outside, '.env')));
    check('init outside a project points at create, not npm install',
      /npx astrobaas create/.test(initOut.stdout) && !/npm install/.test(initOut.stdout));
    const initIn = run(['init', '--force'], site);
    check('init inside a project keeps the npm install steps', initIn.status === 0 && /npm install/.test(initIn.stdout));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The Node floor comes from package.json's `engines`. A copy of the CLI next to
 * a package.json that demands a Node from the future plays the part of an old
 * Node, without a test-only switch in the CLI.
 */
{
  const fake = mkTmp();
  try {
    fs.cpSync(path.join(here, '..', 'bin'), path.join(fake, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(fake, 'package.json'),
      JSON.stringify({ name: 'astrobaas', version: '9.9.9', engines: { node: '>=99.0.0' } }));
    const runFake = (args) => spawnSync(process.execPath, [path.join(fake, 'bin', 'astrobaas.mjs'), ...args], {
      cwd: fake, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });
    const r = runFake(['create', 'x']);
    check('create REFUSES on a Node older than engines.node, and says which it needs',
      r.status === 1 && /needs Node 99\.0\.0 or newer/.test(r.stderr) && !fs.existsSync(path.join(fake, 'x')));
    const init = runFake(['init']);
    check('init on an old Node still works but warns', init.status === 0 && /needs Node 99\.0\.0/.test(init.stderr));
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * THE PACKED TARBALL — the assertion whose absence let a broken CLI ship
 * ------------------------------------------------------------------ */

/**
 * Everything above runs the CLI from the CHECKOUT, where every file exists.
 *
 * The shipped package is a different thing: package.json's `files` decides what
 * an installed copy contains, and `scripts/scaffold.mjs` was not on that list —
 * so `astrobaas plugin new` worked here and failed for every user with a
 * module-not-found stack trace. A test that only runs from the repo cannot
 * catch that, by construction.
 *
 * So this packs the real thing and runs the commands against the output.
 */
{
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrobaas-pack-'));
  try {
    const repo = path.join(here, '..');
    const packed = spawnSync('npm', ['pack', '--pack-destination', packDir, '--silent'], {
      cwd: repo, encoding: 'utf8', timeout: 180000,
    });
    const tarball = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));

    if (packed.status !== 0 || !tarball) {
      // `npm pack` needs a network-free but working npm; if it cannot run at
      // all, say so rather than reporting a pass nobody earned.
      check('npm pack produced a tarball', false);
    } else {
      const extracted = path.join(packDir, 'out');
      fs.mkdirSync(extracted, { recursive: true });
      spawnSync('tar', ['-xzf', path.join(packDir, tarball), '-C', extracted], { encoding: 'utf8' });
      const pkgDir = path.join(extracted, 'package');

      check('the packed CLI is present', fs.existsSync(path.join(pkgDir, 'bin', 'astrobaas.mjs')));
      // The file whose absence was the bug.
      check('THE BUG: the scaffolder is SHIPPED',
        fs.existsSync(path.join(pkgDir, 'scripts', 'scaffold.mjs')));
      check('the offline scripts ship with the helper they import',
        fs.existsSync(path.join(pkgDir, 'scripts', 'lib', 'db-target.mjs')));

      const packedBin = path.join(pkgDir, 'bin', 'astrobaas.mjs');
      const runPacked = (args, cwd) => spawnSync(process.execPath, [packedBin, ...args], {
        cwd, encoding: 'utf8', timeout: 60000,
      });

      const v = runPacked(['version'], pkgDir);
      check('the packed CLI runs', v.status === 0 && /\d+\.\d+\.\d+/.test(v.stdout));

      const h = runPacked(['help'], pkgDir);
      check('the packed CLI prints help', h.status === 0 && /plugin/.test(h.stdout));

      // The command that used to die with a stack trace.
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'astrobaas-packrun-'));
      try {
        const made = runPacked(['plugin', 'new', 'packed-plug'], work);
        check('THE BUG: `plugin new` works from an INSTALLED package',
          made.status === 0 && fs.existsSync(path.join(work, 'src/plugins/packed-plug/index.ts')));
        const theme = runPacked(['theme', 'new', 'packed-theme'], work);
        check('`theme new` works from an installed package', theme.status === 0);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }

      // An offline script must REFUSE rather than write a db.json nothing reads.
      const setupScript = path.join(pkgDir, 'scripts', 'setup.mjs');
      if (fs.existsSync(setupScript)) {
        const refused = spawnSync(process.execPath, [setupScript], {
          cwd: pkgDir, encoding: 'utf8', timeout: 60000,
          env: { ...process.env, DATABASE_URL: 'libsql://example.turso.io' },
        });
        check('THE OTHER BUG: setup REFUSES on a SQL-backed install',
          refused.status === 1 && /DATABASE_URL/.test(refused.stderr));
      }
    }
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
