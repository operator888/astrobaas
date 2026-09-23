#!/usr/bin/env node
/**
 * Theme slot contract + resolution (src/core/theme-slots.ts).
 *
 * The property that matters: a theme overrides what it declares and inherits
 * everything else, so adding a slot later can never break an existing theme.
 * Resolution is tested with plain sentinel values rather than real components —
 * `.astro` modules can't be imported outside Astro, and the merge logic is what
 * carries the risk.
 *
 * Run with:  node tests/theme-slots.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const tmp = path.join(cacheDir, `astrobaas-theme-slots-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/core/theme-slots.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: tmp, logLevel: 'silent',
});
const { THEME_SLOTS, isThemeSlot, overriddenSlots } = await import(pathToFileURL(tmp).href);
await fs.rm(tmp, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/**
 * Mirror of resolveSlots() from theme-runtime.ts. That module imports .astro
 * components, so it can't be loaded here; this reproduces the merge rule and the
 * assertions below pin the behaviour the runtime must keep.
 */
function resolveSlots(defaults, components) {
  const slots = { ...defaults };
  if (components) {
    for (const name of THEME_SLOTS) {
      const override = components[name];
      if (override != null) slots[name] = override;
    }
  }
  return slots;
}

const DEFAULTS = Object.fromEntries(THEME_SLOTS.map((s) => [s, `default:${s}`]));

// ---- the slot catalog ----
{
  check('slot list is non-empty and unique', THEME_SLOTS.length > 0 && new Set(THEME_SLOTS).size === THEME_SLOTS.length);
  check('includes the v1 slots', ['Header', 'Footer', 'PostCard', 'PostArticle', 'Sidebar'].every((s) => THEME_SLOTS.includes(s)));
  check('isThemeSlot accepts real slots', THEME_SLOTS.every((s) => isThemeSlot(s)));
  check('isThemeSlot rejects junk', !isThemeSlot('Nope') && !isThemeSlot('') && !isThemeSlot(null) && !isThemeSlot(42) && !isThemeSlot({}));
  check('isThemeSlot rejects prototype keys', !isThemeSlot('constructor') && !isThemeSlot('__proto__'));
}

// ---- overriddenSlots ----
{
  check('no components → no overrides', overriddenSlots(undefined).length === 0 && overriddenSlots({}).length === 0);
  check('lists only declared slots', JSON.stringify(overriddenSlots({ Header: 'x', PostCard: 'y' })) === JSON.stringify(['Header', 'PostCard']));
  check('ignores null/undefined entries', overriddenSlots({ Header: null, Footer: undefined, PostCard: 'y' }).length === 1);
  check('ignores unknown keys', overriddenSlots({ Header: 'x', Bogus: 'y' }).length === 1);
  check('result is ordered by the canonical slot list', JSON.stringify(overriddenSlots({ PostCard: 'y', Header: 'x' })) === JSON.stringify(['Header', 'PostCard']));
}

// ---- resolution: the forward-compatibility property ----
{
  const tokensOnly = resolveSlots(DEFAULTS, undefined);
  check('a tokens-only theme inherits EVERY default', THEME_SLOTS.every((s) => tokensOnly[s] === `default:${s}`));

  const partial = resolveSlots(DEFAULTS, { Header: 'theme:Header', PostCard: 'theme:PostCard' });
  check('declared slots are overridden', partial.Header === 'theme:Header' && partial.PostCard === 'theme:PostCard');
  check('undeclared slots keep defaults', partial.Footer === 'default:Footer' && partial.PostArticle === 'default:PostArticle' && partial.Sidebar === 'default:Sidebar');
  check('resolution is always complete (no missing slot)', THEME_SLOTS.every((s) => partial[s] != null));

  // A theme written before a slot existed must keep working when one is added.
  const legacy = resolveSlots({ ...DEFAULTS, BrandNewSlot: 'default:BrandNewSlot' }, { Header: 'theme:Header' });
  check('a theme unaware of a NEW slot inherits its default', legacy.BrandNewSlot === 'default:BrandNewSlot');

  check('null/undefined overrides inherit rather than blanking', resolveSlots(DEFAULTS, { Header: null, Footer: undefined }).Header === 'default:Header');
  check('an unknown component key is ignored', resolveSlots(DEFAULTS, { Bogus: 'x' }).Bogus === undefined);
  check('defaults are not mutated by resolution', DEFAULTS.Header === 'default:Header');
}

/* ---- v2 slots: the whole public surface is overridable ---- */
{
  // Home and PageArticle joined in v2 so activating a theme changes the front
  // door and every subpage — the exact gap that made themes feel half-applied.
  // Their presence here is a CONTRACT: removing one breaks shipped themes.
  for (const required of ['Header', 'Footer', 'PostCard', 'PostArticle', 'Sidebar', 'Home', 'PageArticle']) {
    check(`slot ${required} exists`, THEME_SLOTS.includes(required));
  }
  check('isThemeSlot accepts Home', isThemeSlot('Home'));
  check('isThemeSlot accepts PageArticle', isThemeSlot('PageArticle'));
  // A v1 theme that has never heard of the new slots inherits their defaults.
  const v1Theme = { components: { Header: 'v1:Header' } };
  check('a v1 theme reports only what it overrides',
    JSON.stringify(overriddenSlots(v1Theme.components)) === JSON.stringify(['Header']));
}

/* ---- every social link a shipped theme renders is actually supplied ---- */
{
  // A theme's Footer was once added reading social.facebook, social.instagram
  // and social.youtube. The slot type had twitter, github and linkedin only,
  // and site.ts mapped only those three: `astro check` failed on main, and had
  // it compiled the links would simply never have appeared.
  //
  // Read from the themes rather than from a list, so a theme added tomorrow is
  // covered without anyone remembering to update this.
  const themesDir = path.join(here, '..', 'src/themes');
  const slots = await fs.readFile(path.join(here, '..', 'src/core/theme-slots.ts'), 'utf8');
  const site = await fs.readFile(path.join(here, '..', 'src/lib/site.ts'), 'utf8');
  const declared = new Set(
    [...(slots.match(/social\?:\s*\{([\s\S]*?)\}/) ?? ['', ''])[1].matchAll(/(\w+)\?:/g)].map((m) => m[1]),
  );

  const used = new Map();
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.astro')) {
        const src = await fs.readFile(full, 'utf8');
        for (const m of src.matchAll(/\bsocial\.(\w+)/g)) {
          if (!used.has(m[1])) used.set(m[1], path.relative(themesDir, full));
        }
      }
    }
  };
  await walk(themesDir);

  const undeclared = [...used].filter(([k]) => !declared.has(k));
  check(`every social link a theme renders is in FooterProps (${used.size} used: ${[...used.keys()].join(', ') || 'none'})`,
    undeclared.length === 0);
  if (undeclared.length) console.error(`  undeclared: ${undeclared.map(([k, f]) => `${k} (${f})`).join(', ')}`);

  // Declared but never mapped is the same bug one layer down: the theme
  // compiles, the link is always undefined, and nothing says why.
  const unmapped = [...declared].filter((k) => !new RegExp(`${k}:\\s*str\\(map\\.social_${k}\\)`).test(site));
  check(`every declared social link is read from a setting in site.ts (${declared.size} declared)`,
    unmapped.length === 0);
  if (unmapped.length) console.error(`  declared but never mapped: ${unmapped.join(', ')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
