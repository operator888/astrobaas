#!/usr/bin/env node
/**
 * Plugin dependencies — "this pack needs commerce ≥2.0".
 *
 * What is actually being protected: a vertical pack sold on top of a general
 * plugin must not activate against a missing, inactive or wrong-versioned
 * dependency, and the dependency must not be removable while a dependent is
 * running. Both failures are quiet — the pack is simply "on" and does nothing,
 * or breaks somewhere unrelated later.
 *
 * The first block is a deliberate guard against a bug shape this codebase has
 * now hit four times: a field validated correctly and then dropped because a
 * second, hand-written list builds the normalized output. `sections` shipped
 * that way (install returned 201 with `capabilities: []`). So `dependencies` is
 * asserted to ROUND-TRIP, not merely to validate.
 *
 * Run with:  node tests/plugin-dependencies.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, name) {
  const out = path.join(cacheDir, `astrobaas-${name}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const { validateManifest } = await load('src/core/manifest.ts', 'manifest-deps');
const {
  unmetDependencies, unmetForManifest, dependentsOf, activeDependentsOf,
  blockedByDependentsMessage,
} = await load('src/lib/plugin-dependencies.ts', 'plugin-deps');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

const base = (extra) => ({
  id: 'optical', name: 'Optical Pack', version: '1.0.0',
  capabilities: { css: '.x{}' },
  ...extra,
});

/* ---------------- THE round-trip (bug pattern: validated then dropped) ---------------- */
{
  const res = validateManifest(base({ dependencies: { commerce: '^2.0.0' } }));
  check('a manifest with dependencies validates', res.ok === true);
  check('...and `dependencies` SURVIVES into the normalized manifest',
    res.manifest?.dependencies?.commerce === '^2.0.0');
  check('...with nothing else invented',
    Object.keys(res.manifest.dependencies).length === 1);
  check('a manifest without dependencies does not gain an empty object',
    validateManifest(base({})).manifest.dependencies === undefined);
  check('an empty dependencies object is not carried through',
    validateManifest(base({ dependencies: {} })).manifest.dependencies === undefined);
}

/* ---------------- validation ---------------- */
{
  const errs = (extra) => validateManifest(base(extra)).errors;

  check('a non-object dependencies is refused',
    errs({ dependencies: 'commerce' }).some((e) => e.includes('must be an object')));
  check('an invalid plugin id is refused',
    errs({ dependencies: { 'Not An Id': '^1.0.0' } }).some((e) => e.includes('not a valid plugin id')));
  check('self-dependency is refused',
    errs({ dependencies: { optical: '^1.0.0' } }).some((e) => e.includes('cannot depend on itself')));

  // A range this host cannot parse must be an ERROR, not a dependency that
  // silently never matches — the author would have no way to find out why.
  for (const bad of ['1.x', '>=1.0.0 <2.0.0', 'latest', '^1.0.0 || ^2.0.0', '']) {
    check(`range ${JSON.stringify(bad)} is refused with guidance`,
      errs({ dependencies: { commerce: bad } }).some((e) => e.includes('not a supported version range')));
  }
  for (const good of ['^2.0.0', '~1.2.3', '>=1.0.0', '1.2.3', '*']) {
    check(`range ${JSON.stringify(good)} is accepted`,
      validateManifest(base({ dependencies: { commerce: good } })).ok === true);
  }
  check('too many dependencies are refused',
    errs({ dependencies: Object.fromEntries(
      Array.from({ length: 13 }, (_, i) => [`dep-${i}`, '^1.0.0'])) })
      .some((e) => e.includes('Too many dependencies')));
}

/* ---------------- resolution: the three ways a dependency is unmet ---------------- */
{
  const commerce = (o = {}) => ({ id: 'commerce', name: 'Commerce', version: '2.1.0', active: true, ...o });

  check('a satisfied dependency reports nothing',
    unmetDependencies({ commerce: '^2.0.0' }, [commerce()]).length === 0);
  check('no dependencies reports nothing',
    unmetDependencies(undefined, [commerce()]).length === 0);

  const missing = unmetDependencies({ commerce: '^2.0.0' }, []);
  check('a MISSING dependency is reported', missing[0]?.reason === 'missing');
  check('...and the message names it', missing[0]?.message.includes('commerce'));

  const inactive = unmetDependencies({ commerce: '^2.0.0' }, [commerce({ active: false })]);
  check('an INACTIVE dependency is reported', inactive[0]?.reason === 'inactive');
  check('...and says it is installed but off', inactive[0]?.message.includes('not active'));

  const wrong = unmetDependencies({ commerce: '^3.0.0' }, [commerce()]);
  check('an INCOMPATIBLE version is reported', wrong[0]?.reason === 'incompatible');
  check('...and names both the range and what is installed',
    wrong[0]?.message.includes('^3.0.0') && wrong[0]?.message.includes('2.1.0'));

  // Version before activity: telling someone to activate a plugin that would
  // still be the wrong version wastes a round trip.
  const both = unmetDependencies({ commerce: '^3.0.0' }, [commerce({ active: false })]);
  check('a wrong-versioned INACTIVE dependency reports the version problem',
    both[0]?.reason === 'incompatible');

  const many = unmetDependencies({ commerce: '^2.0.0', mailer: '^1.0.0' }, []);
  check('every unmet dependency is reported, not just the first', many.length === 2);

  check('unmetForManifest reads the manifest field',
    unmetForManifest({ dependencies: { commerce: '^9.0.0' } }, [commerce()]).length === 1);
}

/* ---------------- reverse: who would break if this went away ---------------- */
{
  const installed = [
    { id: 'commerce', name: 'Commerce', version: '2.1.0', active: true },
    { id: 'optical', name: 'Optical Pack', version: '1.0.0', active: true, dependencies: { commerce: '^2.0.0' } },
    { id: 'lenses', name: 'Lens Configurator', version: '1.0.0', active: false, dependencies: { commerce: '^2.0.0' } },
    { id: 'seo', name: 'SEO', version: '1.0.0', active: true },
  ];

  const deps = dependentsOf('commerce', installed);
  check('every dependent is found regardless of state', deps.length === 2);
  check('an unrelated plugin is not a dependent', !deps.some((d) => d.id === 'seo'));
  check('a plugin is never its own dependent', !dependentsOf('commerce', installed).some((d) => d.id === 'commerce'));

  const active = activeDependentsOf('commerce', installed);
  check('only ACTIVE dependents block removal', active.length === 1 && active[0].id === 'optical');
  check('nothing depends on a leaf plugin', dependentsOf('seo', installed).length === 0);

  // The range is deliberately NOT consulted: "will removing this break
  // something running?" does not depend on whether the range still matches, and
  // a drifted range is exactly when a silent removal hurts most.
  const drifted = [
    { id: 'commerce', name: 'Commerce', version: '2.1.0', active: true },
    { id: 'optical', name: 'Optical', version: '1.0.0', active: true, dependencies: { commerce: '^99.0.0' } },
  ];
  check('a dependent with an unsatisfiable range still blocks removal',
    activeDependentsOf('commerce', drifted).length === 1);

  const msg = blockedByDependentsMessage('Commerce', active, 'uninstall');
  check('the refusal names the dependent', msg.includes('Optical Pack'));
  check('...and says what to do', /Deactivate it first/.test(msg));
  check('the plural form reads correctly',
    /depend on it\. Deactivate them first/.test(
      blockedByDependentsMessage('Commerce', deps, 'deactivate')));
}

/* ---------------- the prototype-chain hole ---------------- */
{
  // `pluginId in deps` walks Object.prototype, so a plugin id of `constructor`
  // matched EVERY plugin declaring any dependency — and would then block their
  // removal. The dependencies object comes from JSON.parse, so it has the
  // prototype.
  const installed = [
    { id: 'constructor', name: 'Evil', version: '1.0.0', active: true },
    { id: 'optical', name: 'Optical', version: '1.0.0', active: true, dependencies: { commerce: '^2.0.0' } },
  ];
  check('an id colliding with an Object.prototype key matches nothing',
    dependentsOf('constructor', installed).length === 0);
  for (const key of ['toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    check(`...same for "${key}"`, dependentsOf(key, installed).length === 0);
  }
  check('a real dependency still resolves', dependentsOf('commerce', installed).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
