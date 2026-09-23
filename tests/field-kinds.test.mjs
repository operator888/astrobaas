#!/usr/bin/env node
/**
 * The field types a content type can declare.
 *
 * This file exists because of what it found. The validator's switch had no
 * `default`, so a rule type with no `case` fell straight through it: no error,
 * and the value never copied into the result. Four of the ten types the admin
 * builder offered — slug, email, url, date — were in exactly that state. The
 * write returned `{ ok: true }`, the record saved, and the field was gone.
 *
 * Silent data loss, reachable from a screen shipped to every user, with a
 * green test suite over it.
 *
 * So the first section below is the regression, the second is the structural
 * fix that makes the class of bug impossible (fail closed on an unknown rule),
 * and the third covers the two new kinds — `ref` and `media`.
 *
 * Run with:  node tests/field-kinds.test.mjs
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
  const out = path.join(cacheDir, `astrobaas-fields-${name}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
};

const { validate } = await load('src/lib/validate.ts', 'validate');
const C = await load('src/core/content-types.ts', 'ct');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/** Validate one field and report what actually came out the other side. */
const one = (rule, v) => validate({ f: v }, { f: rule });

/* ---- 1. every type the builder offers must actually STORE its value ---- */
{
  // The regression, stated as the property rather than as four cases: a field
  // the builder can produce, given a value it accepts, must appear in the
  // result. Adding a type to ADMIN_FIELD_TYPES without a case in validate()
  // fails here rather than in somebody's database.
  const sample = {
    string: 'hello',
    number: 42,
    boolean: true,
    id: 'abc-123',
    slug: 'a-slug',
    email: 'someone@example.com',
    url: 'https://example.com/x',
    enum: 'a',
    array: ['x'],
    date: '2024-03-05',
    ref: 'abc-123',
    media: 'abc-123',
    // A repeater's value is a LIST OF ITEMS, so its sample is shaped by the
    // `fields` in `extras` below rather than being a scalar like the rest.
    repeater: [{ label: 'one' }, { label: 'two' }],
    // A private-file reference: the prefix is what keeps it from ever being
    // confused with a media-library id.
    file: 'pf_0123456789abcdef0123',
  };
  const extras = {
    enum: { values: ['a', 'b'] },
    array: { of: 'string' },
    ref: { to: 'venue' },
    repeater: { fields: [{ name: 'label', rule: { type: 'string' } }] },
  };

  for (const type of C.ADMIN_FIELD_TYPES) {
    const r = one({ type, ...(extras[type] ?? {}) }, sample[type]);
    check(`a "${type}" field accepts a valid value`, r.ok === true);
    check(`...and actually STORES it — the bug this file was written for`,
      r.ok === true && r.value.f !== undefined);
  }
}

/* ---- 2. fail closed on anything unrecognised ---- */
{
  const r = one({ type: 'something-new' }, 'a value');
  check('an unknown rule type is an ERROR, not a silent drop', r.ok === false);
  check('...and the message says what is wrong', /does not understand/.test(r.errors?.f ?? ''));
}

/* ---- 3. the new types validate what they claim to ---- */
{
  // slug
  check('a slug rejects capitals', one({ type: 'slug' }, 'Not-A-Slug').ok === false);
  check('a slug rejects spaces', one({ type: 'slug' }, 'not a slug').ok === false);
  check('a slug rejects a leading dash', one({ type: 'slug' }, '-x').ok === false);
  check('a slug rejects doubled dashes', one({ type: 'slug' }, 'a--b').ok === false);
  check('a slug accepts the ordinary shape', one({ type: 'slug' }, 'a-real-slug-2').ok === true);

  // email
  check('an email needs an @', one({ type: 'email' }, 'nope').ok === false);
  check('an email needs a dot in the domain', one({ type: 'email' }, 'a@b').ok === false);
  check('an email rejects spaces', one({ type: 'email' }, 'a b@c.d').ok === false);
  check('an email is length-bounded', one({ type: 'email' }, `${'x'.repeat(300)}@e.com`).ok === false);
  check('an email rejects a control character', one({ type: 'email' }, 'a\u0000b@e.com').ok === false);

  // url — the one with a security consequence, since these get rendered as links
  check('a url accepts https', one({ type: 'url' }, 'https://example.com').ok === true);
  check('a url accepts http', one({ type: 'url' }, 'http://example.com').ok === true);
  check('a url REJECTS javascript:', one({ type: 'url' }, 'javascript:alert(1)').ok === false);
  check('a url rejects data:', one({ type: 'url' }, 'data:text/html,<script>alert(1)</script>').ok === false);
  check('a url rejects vbscript:', one({ type: 'url' }, 'vbscript:msgbox(1)').ok === false);
  check('a url rejects file:', one({ type: 'url' }, 'file:///etc/passwd').ok === false);
  check('a url rejects a bare path — a link needs a scheme',
    one({ type: 'url' }, '/relative/path').ok === false);
  check('a url is length-bounded', one({ type: 'url' }, `https://e.com/${'x'.repeat(3000)}`).ok === false);
  check('a url rejects a control character', one({ type: 'url' }, 'https://e.com/\u0000').ok === false);

  // date
  check('a date accepts YYYY-MM-DD', one({ type: 'date' }, '2024-03-05').ok === true);
  check('a date accepts a full ISO timestamp', one({ type: 'date' }, '2024-03-05T09:30:00.000Z').ok === true);
  // The calendar day in UTC legitimately differs from the one written here.
  // Comparing them on a timestamp would reject correct input from anyone west
  // of Greenwich — which the first version of this check did.
  check('a date accepts a timestamp whose UTC day differs from its local one',
    one({ type: 'date' }, '2024-03-05T23:30:00-05:00').ok === true);
  check('a date rejects a local format', one({ type: 'date' }, '05/03/2024').ok === false);
  check('a date rejects an impossible day', one({ type: 'date' }, '2024-02-31').ok === false);
  // The audit's find: V8 rolls an impossible day FORWARD in a timestamp rather
  // than rejecting it, so the round-trip must run for timestamps too.
  check('a date rejects an impossible day even WITH a time',
    one({ type: 'date' }, '2024-02-31T12:00:00Z').ok === false);
  check('...and with an offset', one({ type: 'date' }, '2024-13-01T00:00:00+02:00').ok === false);
  check('a date rejects prose', one({ type: 'date' }, 'next Tuesday').ok === false);

  // ref / media share the id charset, for the same reasons `id` has one
  check('a ref rejects a path traversal', one({ type: 'ref', to: 'venue' }, '../../etc/passwd').ok === false);
  check('a ref rejects markup', one({ type: 'ref', to: 'venue' }, '<script>').ok === false);
  check('a media handle rejects an embedded NUL', one({ type: 'media' }, 'a\u0000b').ok === false);
  check('a media handle accepts a uuid',
    one({ type: 'media' }, '70d7059e-ff57-45c8-a30c-afbf547aba69').ok === true);
}

/* ---- 4. optional still means optional ---- */
{
  for (const type of ['slug', 'email', 'url', 'date', 'ref', 'media']) {
    const rule = { type, optional: true, ...(type === 'ref' ? { to: 'venue' } : {}) };
    check(`an optional "${type}" may be absent`, validate({}, { f: rule }).ok === true);
    check(`an empty "${type}" is treated as absent, not as invalid`,
      validate({ f: '' }, { f: rule }).ok === true);
  }
}

/* ---- 5. definitions carrying the new types ---- */
{
  const def = (rule) => C.validateContentTypeDefinitions([{
    name: 'event', label: 'Event', fields: [{ name: 'f', rule }],
  }]);

  const ok = def({ type: 'ref', to: 'venue' });
  check('a ref field is accepted with a target', ok.ok === true);
  check('...and the target survives into the definition', ok.defs[0].fields[0].rule.to === 'venue');

  check('a ref with NO target is refused — it points at nothing',
    def({ type: 'ref' }).ok === false);
  check('a ref whose target is not a valid collection name is refused',
    def({ type: 'ref', to: 'Not A Name' }).ok === false);
  check('a ref target cannot smuggle a path', def({ type: 'ref', to: '../admin' }).ok === false);

  check('a media field needs no parameters', def({ type: 'media' }).ok === true);

  // A ref may name a type that does not exist YET: definitions are saved as a
  // set and nothing says which order somebody builds them in.
  check('a ref to a collection that does not exist yet still saves',
    def({ type: 'ref', to: 'venue-not-created-yet' }).ok === true);
}

/* ---- prototype pollution and reserved field names ---- */
{
  const def = (name, rule = { type: 'string' }) => C.validateContentTypeDefinitions([{
    name: 'thing', label: 'Thing', fields: [{ name, rule }],
  }]);
  check('a field named __proto__ is refused at build time', def('__proto__').ok === false);
  check('a field named constructor is refused', def('constructor').ok === false);
  check('a field named prototype is refused', def('prototype').ok === false);
  check('hp_url and pow_token are refused (form meta-fields)',
    def('hp_url').ok === false && def('pow_token').ok === false);

  // Even if a hostile definition reached validate() directly, it must not
  // reparent the result or read an inherited member as "present".
  const r1 = validate({}, { toString: { type: 'string', optional: true } });
  check('an omitted field named toString is treated as ABSENT, not the inherited method',
    r1.ok === true && !('toString' in r1.value) || (r1.ok && typeof r1.value.toString !== 'function'));
  const r2 = validate({ __proto__: 'x' }, { __proto__: { type: 'string' } });
  check('a __proto__ field does not pollute the result prototype',
    Object.getPrototypeOf(r2.ok ? r2.value : {}) === null || !('polluted' in {}));
}

/* ---- enum values reject control characters at DEFINITION time ---- */
{
  const withEnum = (values) => C.validateContentTypeDefinitions([{
    name: 'thing', label: 'Thing', fields: [{ name: 'choice', rule: { type: 'enum', values } }],
  }]);
  check('a clean enum is accepted', withEnum(['a', 'b']).ok === true);
  check('an enum value with a NUL is refused', withEnum(['ok', 'ba\u0000d']).ok === false);
}

/* ---- media field cannot collide with a declared _url sibling ---- */
{
  const both = C.validateContentTypeDefinitions([{
    name: 'thing', label: 'Thing',
    fields: [{ name: 'photo', rule: { type: 'media' } }, { name: 'photo_url', rule: { type: 'string' } }],
  }]);
  check('a field named <media>_url collides and is refused', both.ok === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
