#!/usr/bin/env node
/**
 * Declarative plugin manifest validation (src/core/manifest.ts).
 *
 * Manifests arrive from OUTSIDE the trust boundary (upload / registry), so this
 * suite is adversarial: it asserts the happy path works and that every hostile
 * or malformed shape is refused rather than silently accepted.
 *
 * Run with:  node tests/manifest.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel) {
  const tmp = path.join(cacheDir, `astrobaas-${path.basename(rel)}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', rel)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    outfile: tmp,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(tmp).href);
  await fs.rm(tmp, { force: true });
  return mod;
}

const { validateManifest, renderHeadTags, apiRangeSatisfied, manifestContentTypes, MANIFEST_LIMITS } =
  await load('src/core/manifest.ts');
const { checkWebhookUrl } = await load('src/lib/url-guard.ts');
const ctypes = await load('src/core/content-types.ts');
const { fetchRegistryManifest } = await load('src/lib/registry.ts');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

const base = {
  id: 'acme-seo',
  name: 'Acme SEO',
  version: '1.2.0',
  capabilities: { headTags: [{ tag: 'meta', attrs: { name: 'author', content: 'Acme' } }] },
};
const ok = (extra = {}) => validateManifest({ ...base, ...extra });

// ---- happy path ----
{
  const r = ok();
  check('valid manifest passes', r.ok && r.errors.length === 0);
  check('returns a normalized manifest', r.manifest?.id === 'acme-seo' && r.manifest?.name === 'Acme SEO');

  const full = validateManifest({
    ...base,
    description: 'SEO helper',
    author: 'Acme Inc',
    homepage: 'https://acme.example/plugin',
    astrobaasApi: '^1.0.0',
    capabilities: {
      headTags: [{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://cdn.example' } }],
      css: '.a{color:red}',
      contentTypes: [{ name: 'faq', label: 'FAQ', fields: [{ name: 'question', rule: { type: 'string' } }] }],
      webhooks: [{ event: 'post.published', url: 'https://hooks.example/x' }],
    },
  }, { checkWebhookUrl });
  check('all four capabilities validate together', full.ok);
  check('contentTypes map to definitions', manifestContentTypes(full.manifest)[0].name === 'faq');

  // There are TWO copy steps between a manifest and a registered type, and only
  // one of them was ever checked:
  //
  //   validateManifest()      -> normalized manifest   (copies capabilities by
  //                                                     reference; survives)
  //   manifestContentTypes()  -> ContentTypeDefinition (hand-written field
  //                                                     list; DROPPED it)
  //
  // A manifest declaring visibility:"public" validated, installed, and then
  // registered PRIVATE — so the author's storefront saw 404 with no error
  // anywhere to explain it. Asserted on the definition that actually reaches
  // registerContentType(), not on the normalized manifest.
  const visManifest = validateManifest({
    ...base,
    capabilities: {
      contentTypes: [
        { name: 'faq', label: 'FAQ', visibility: 'public', fields: [{ name: 'q', rule: { type: 'string' } }] },
        { name: 'enquiry', label: 'Enquiry', fields: [{ name: 'body', rule: { type: 'string' } }] },
      ],
    },
  });
  const defs = visManifest.ok ? manifestContentTypes(visManifest.manifest) : [];
  check('manifest visibility reaches the registered definition',
    defs[0]?.visibility === 'public');
  check('a manifest type with no visibility stays undefined (so the private default applies)',
    'enquiry' === defs[1]?.name && defs[1]?.visibility === undefined);
}

// ---- identity / shape ----
{
  check('rejects non-object', !validateManifest('nope').ok && !validateManifest(null).ok);
  check('rejects bad id (uppercase/space)', !ok({ id: 'Acme SEO' }).ok && !ok({ id: 'A' }).ok);
  check('rejects non-semver version', !ok({ version: '1.2' }).ok && !ok({ version: 'latest' }).ok);
  check('rejects missing name', !ok({ name: '' }).ok);
  check('rejects capabilities that is not an object', !validateManifest({ ...base, capabilities: [] }).ok);
  check('rejects empty capabilities', !validateManifest({ ...base, capabilities: {} }).ok);
  check('rejects UNKNOWN capability (no silent ignore)', !validateManifest({ ...base, capabilities: { ...base.capabilities, exec: 'rm -rf /' } }).ok);
  check('rejects non-https homepage', !ok({ homepage: 'http://acme.example' }).ok && !ok({ homepage: 'javascript:alert(1)' }).ok);
}

// ---- api version gate ----
{
  check('accepts a matching major range', ok({ astrobaasApi: '^1.0.0' }).ok);
  check('rejects a future major', !ok({ astrobaasApi: '^2.0.0' }).ok);
  check('apiRangeSatisfied handles bare/^/~/x forms', apiRangeSatisfied('1') && apiRangeSatisfied('^1.2.3') && apiRangeSatisfied('~1.0') && apiRangeSatisfied('1.x') && !apiRangeSatisfied('3.0.0'));
  check('unspecified range is allowed', apiRangeSatisfied(undefined));
}

// ---- headTags: the injection surface ----
{
  const bad = (headTags) => validateManifest({ ...base, capabilities: { headTags } });
  check('rejects a non-meta/link tag (e.g. script)', !bad([{ tag: 'script', attrs: {} }]).ok);
  check('rejects a disallowed attribute (onload)', !bad([{ tag: 'meta', attrs: { onload: 'alert(1)' } }]).ok);
  check('rejects http/javascript href', !bad([{ tag: 'link', attrs: { rel: 'x', href: 'http://a.example' } }]).ok && !bad([{ tag: 'link', attrs: { rel: 'x', href: 'javascript:alert(1)' } }]).ok);
  check('allows a root-relative href', bad([{ tag: 'link', attrs: { rel: 'icon', href: '/favicon.svg' } }]).ok);
  check('rejects protocol-relative //host', !bad([{ tag: 'link', attrs: { rel: 'x', href: '//evil.example' } }]).ok);
  check('enforces a headTags count cap', !bad(Array.from({ length: MANIFEST_LIMITS.headTags + 1 }, () => ({ tag: 'meta', attrs: { name: 'a', content: 'b' } }))).ok);

  // Rendering must escape, so a quote can't break out of the attribute.
  const html = renderHeadTags([{ tag: 'meta', attrs: { name: 'x', content: '"><script>alert(1)</script>' } }]);
  check('renderHeadTags escapes quotes/angle brackets', !html.includes('<script>') && html.includes('&quot;') && html.includes('&lt;'));
  check('renderHeadTags drops unknown attrs defensively', !renderHeadTags([{ tag: 'meta', attrs: { onload: 'x', name: 'ok', content: 'c' } }]).includes('onload'));
  check('renderHeadTags handles empty input', renderHeadTags(undefined) === '' && renderHeadTags([]) === '');
}

// ---- css ----
{
  const css = (v) => validateManifest({ ...base, capabilities: { css: v } });
  check('accepts css string', css('.a{color:red}').ok);
  check('rejects non-string css', !css(123).ok);
  check('enforces css size cap', !css('a'.repeat(MANIFEST_LIMITS.css + 1)).ok);
}

// ---- contentTypes ----
{
  const ct = (v) => validateManifest({ ...base, capabilities: { contentTypes: v } });
  check('rejects a reserved type name', !ct([{ name: 'post', label: 'P', fields: [{ name: 'a', rule: { type: 'string' } }] }]).ok);
  check('rejects a bad type name', !ct([{ name: 'Bad Name', label: 'P', fields: [{ name: 'a', rule: { type: 'string' } }] }]).ok);
  check('rejects empty fields', !ct([{ name: 'faq', label: 'F', fields: [] }]).ok);
  check('rejects an unknown field rule type', !ct([{ name: 'faq', label: 'F', fields: [{ name: 'a', rule: { type: 'function' } }] }]).ok);
  check('rejects an invalid field name', !ct([{ name: 'faq', label: 'F', fields: [{ name: '2bad-name', rule: { type: 'string' } }] }]).ok);
  check('enforces fields-per-type cap', !ct([{ name: 'faq', label: 'F', fields: Array.from({ length: MANIFEST_LIMITS.fieldsPerType + 1 }, (_, i) => ({ name: `f${i}`, rule: { type: 'string' } })) }]).ok);

  // ---- D2-4: read policy ----
  const withVis = (v) => ct([{ name: 'faq', label: 'F', visibility: v, fields: [{ name: 'a', rule: { type: 'string' } }] }]);
  check('accepts visibility: public', withVis('public').ok);
  check('accepts visibility: staff', withVis('staff').ok);
  // A typo must be an ERROR, never a silent fallback — one direction leaks the
  // collection, the other breaks a storefront with no message saying why.
  check('rejects an unknown visibility', !withVis('publik').ok);
  check('rejects a non-string visibility', !withVis(true).ok);

  // "The schema names it, the copy forgets it" is this repo's second-most
  // repeated bug: a field validated correctly and then dropped because a
  // hand-written list builds the output. Assert visibility SURVIVES validation
  // rather than assuming the normalizer carries it.
  const kept = ct([{ name: 'faq', label: 'F', visibility: 'public', fields: [{ name: 'a', rule: { type: 'string' } }] }]);
  check('visibility survives normalization',
    kept.ok && kept.manifest.capabilities.contentTypes[0].visibility === 'public');
  // Absent stays absent, so the consumer's default (private) is what applies —
  // normalization must not helpfully invent 'public'.
  const bare = ct([{ name: 'faq', label: 'F', fields: [{ name: 'a', rule: { type: 'string' } }] }]);
  check('an absent visibility is not defaulted to public during normalization',
    bare.ok && bare.manifest.capabilities.contentTypes[0].visibility === undefined);
}

// ---- content-type registry: deny-by-default read policy (D2-4) ----
{
  const fields = [{ name: 'a', rule: { type: 'string' } }];
  check('a type with no visibility is NOT public',
    ctypes.contentTypeIsPublic({ name: 'x', label: 'X', fields }) === false);
  check('visibility: staff is not public',
    ctypes.contentTypeIsPublic({ name: 'x', label: 'X', fields, visibility: 'staff' }) === false);
  check('visibility: public is public',
    ctypes.contentTypeIsPublic({ name: 'x', label: 'X', fields, visibility: 'public' }) === true);
  check('an undefined type is not public', ctypes.contentTypeIsPublic(undefined) === false);

  // Registration rejects a bad value rather than storing it, so the typo is
  // caught where the author can still see it.
  let threw = false;
  try {
    ctypes.registerContentType({ name: 'bad-vis', label: 'B', fields, visibility: 'publik' });
  } catch { threw = true; }
  check('registerContentType rejects an invalid visibility', threw);
  ctypes.clearContentTypes();
}

// ---- webhooks: SSRF is enforced at validation time ----
{
  const wh = (v) => validateManifest({ ...base, capabilities: { webhooks: v } }, { checkWebhookUrl });
  check('accepts an external https webhook', wh([{ event: 'post.published', url: 'https://hooks.example/x' }]).ok);
  check('rejects http webhook', !wh([{ event: 'post.published', url: 'http://hooks.example/x' }]).ok);
  check('rejects localhost (SSRF)', !wh([{ event: 'post.published', url: 'https://localhost/x' }]).ok);
  check('rejects RFC-1918 (SSRF)', !wh([{ event: 'post.published', url: 'https://192.168.1.10/x' }]).ok);
  check('rejects cloud metadata IP (SSRF)', !wh([{ event: 'post.published', url: 'https://169.254.169.254/latest/meta-data' }]).ok);
  check('requires an event name', !wh([{ event: '', url: 'https://hooks.example/x' }]).ok);
}

// ---- error reporting quality ----
{
  const r = validateManifest({ id: 'BAD', name: '', version: 'x', capabilities: {} });
  check('reports multiple errors at once', r.errors.length >= 3);
  check('no manifest returned when invalid', r.manifest === undefined);
}

// ---- registry listings: a "bundled" entry is a DIRECTORY POINTER, never
// something the registry can deliver. The install path must refuse it outright
// rather than fetching `undefined` and skipping the checksum gate. ----
{
  const bundled = { id: 'smtp2go', name: 'SMTP2GO', version: '1.0.0', kind: 'bundled' };
  let msg = '';
  try {
    await fetchRegistryManifest(bundled);
  } catch (err) {
    msg = String(err.message);
  }
  check('installing a bundled listing is refused', msg.length > 0);
  check('the refusal explains it ships with AstroBaaS', /ships with AstroBaaS|bundled/i.test(msg));

  // The dangerous shape: declarative (so it looks installable) but with no
  // checksum. Without the guard this reaches fetchText(undefined).
  for (const [label, entry] of [
    ['no manifestUrl', { id: 'x', name: 'x', version: '1.0.0' }],
    ['no sha256', { id: 'x', name: 'x', version: '1.0.0', manifestUrl: 'https://example.com/m.json' }],
  ]) {
    let refused = false;
    try {
      await fetchRegistryManifest(entry);
    } catch {
      refused = true;
    }
    check(`a declarative entry with ${label} is refused before any fetch`, refused);
  }

  // A bundled entry that also carries a URL would imply the registry can ship
  // code. It must not validate at all.
  let sneaky = false;
  try {
    await fetchRegistryManifest({ id: 'x', name: 'x', version: '1.0.0', kind: 'bundled', manifestUrl: 'https://evil.example/m.json', sha256: 'a'.repeat(64) });
  } catch {
    sneaky = true;
  }
  check('a bundled entry carrying a manifestUrl is still refused', sneaky);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
