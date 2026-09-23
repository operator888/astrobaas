#!/usr/bin/env node
/**
 * Public-write content types — the pure half.
 *
 * A content type that accepts anonymous writes is an endpoint on the internet
 * that strangers can put records into. Everything about whether that endpoint
 * exists is decided by two words in a stored definition, so this file is about
 * those two words: what counts as "yes", what a bad value does, and what a
 * definition that says nothing means.
 *
 * The behaviour of the endpoint itself — honeypot, proof-of-work, rate limit,
 * what a submitter can read back — is covered against a running server in
 * tests/smoke.mjs, on all three drivers.
 *
 * Run with:  node tests/public-forms.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const load = async (entry, name) => {
  const out = path.join(cacheDir, `astrobaas-forms-${name}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
};

const C = await load('src/core/content-types.ts', 'core');
const M = await load('src/core/manifest.ts', 'manifest');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const fields = [{ name: 'message', rule: { type: 'string', max: 500 } }];

/* ---- the predicate ---- */
{
  const p = C.contentTypeAcceptsPublicWrites;
  check('a type that says nothing accepts nothing from strangers', p({ name: 'a', label: 'A', fields }) === false);
  check('"staff" is not public', p({ writable: 'staff' }) === false);
  check('"public" is public', p({ writable: 'public' }) === true);
  // Every one of these is a value somebody could end up with: a typo, a
  // checkbox serialised the wrong way, a hostile definition.
  check('"PUBLIC" is not public — the exact word or nothing', p({ writable: 'PUBLIC' }) === false);
  check('true is not public', p({ writable: true }) === false);
  check('1 is not public', p({ writable: 1 }) === false);
  check('"publik" is not public', p({ writable: 'publik' }) === false);
  check('an undefined definition is not public', p(undefined) === false);

  // The two axes are independent, and this is the pair that matters: a form
  // people fill in privately is written by anyone and read by nobody.
  check('read and write policies do not imply each other',
    C.contentTypeIsPublic({ visibility: 'staff', writable: 'public' }) === false
    && p({ visibility: 'staff', writable: 'public' }) === true);
  check('...in the other direction too',
    C.contentTypeIsPublic({ visibility: 'public', writable: 'staff' }) === true
    && p({ visibility: 'public', writable: 'staff' }) === false);
}

/* ---- stored definitions ---- */
{
  const v = (ct) => C.validateContentTypeDefinitions([{ name: 'enquiry', label: 'Enquiry', fields, ...ct }]);

  check('writable: "public" survives validation', v({ writable: 'public' }).defs[0].writable === 'public');
  check('writable: "staff" survives validation', v({ writable: 'staff' }).defs[0].writable === 'staff');
  check('an absent writable stays absent rather than becoming a default here',
    v({}).defs[0].writable === undefined);

  const bad = v({ writable: 'publik' });
  check('an unrecognised writable is an ERROR, not a silent fallback', bad.ok === false);
  check('...and the message names the field', /writable/.test(bad.errors.join()));
  check('...and the definition is not registered at all', bad.defs.length === 0);

  check('a non-string writable is refused', v({ writable: true }).ok === false);

  check('notifyOnSubmission survives when true', v({ notifyOnSubmission: true }).defs[0].notifyOnSubmission === true);
  check('...and a non-boolean is refused', v({ notifyOnSubmission: 'yes' }).ok === false);
  check('...and false is stored as absent, not as false',
    v({ notifyOnSubmission: false }).defs[0].notifyOnSubmission === undefined);

  // The bug this whole shape exists to prevent: a field declared on the
  // interface, validated correctly, and then dropped by a hand-written copy on
  // the way to the registry. It happened to `visibility` once already.
  const kept = v({ writable: 'public', notifyOnSubmission: true, visibility: 'staff' }).defs[0];
  check('every declared field reaches the registered definition',
    kept.writable === 'public' && kept.notifyOnSubmission === true
    && kept.visibility === 'staff' && kept.fields.length === 1);
}

/* ---- manifests get the same treatment ---- */
{
  const manifest = (ct) => ({
    id: 'test-plugin', name: 'Test', version: '1.0.0',
    capabilities: { contentTypes: [{ name: 'enquiry', label: 'Enquiry', fields, ...ct }] },
  });

  const good = M.validateManifest(manifest({ writable: 'public' }));
  check('a manifest may declare a public form', good.ok === true);
  const carried = M.manifestContentTypes(good.manifest ?? manifest({ writable: 'public' }));
  check('...and the policy actually reaches the definition — the "declared, '
    + 'validated, then silently dropped" bug', carried[0].writable === 'public');

  const bad = M.validateManifest(manifest({ writable: 'publik' }));
  check('a manifest with an unrecognised writable is refused', bad.ok === false);
  check('...by name', /writable/.test((bad.errors ?? []).join()));

  const silent = M.manifestContentTypes(manifest({}));
  check('a manifest that says nothing produces a staff-only type',
    C.contentTypeAcceptsPublicWrites(silent[0]) === false);

  check('notifyOnSubmission is carried from a manifest too',
    M.manifestContentTypes(manifest({ notifyOnSubmission: true }))[0].notifyOnSubmission === true);
}

/* ---- the captcha surface exists and is spelled the same everywhere ---- */
{
  const cap = await load('src/lib/captcha.ts', 'captcha');
  const settings = await load('src/lib/settings-validate.ts', 'settings');
  check('there is a captcha surface for public forms',
    cap.CAPTCHA_SURFACES.includes('forms'));
  // settings-validate keeps its own copy of the list by value, on purpose.
  // A copy that drifts means the admin form silently protects nothing.
  check('the settings validator accepts every surface the captcha module declares',
    cap.CAPTCHA_SURFACES.every((id) => settings.validateSetting('captcha_surfaces', [id]) === null));
  check('...and still refuses one it does not know',
    settings.validateSetting('captcha_surfaces', ['made-up']) !== null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
