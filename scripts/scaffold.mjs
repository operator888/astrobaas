/**
 * Scaffolding for extensions: code plugins, declarative manifests, and themes.
 *
 * Driven by `astrobaas plugin new`, `astrobaas plugin manifest`, and
 * `astrobaas theme new`. Kept as data + small string builders so the CLI stays
 * thin and the templates are easy to review in one place.
 *
 * Everything generated here is deliberately *complete and runnable*: the whole
 * point is that "hello world" costs 60 seconds, not an afternoon of reading.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Same id rule the plugin/theme registries and the manifest validator enforce. */
export const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;

export function validateId(id) {
  if (!id) return 'An id is required.';
  if (!ID_RE.test(id)) return `Invalid id "${id}" — use kebab-case, 2–41 chars, starting with a letter.`;
  return null;
}

/** Turn "my-plugin" into "My Plugin" for a default display name. */
export function titleize(id) {
  return id.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/* ---------- templates ---------- */

export function codePluginTemplate(id) {
  const name = titleize(id);
  return `import { definePlugin, PLUGIN_HOOKS } from 'astrobaas/core';
import type { Post } from 'astrobaas/core';

/**
 * ${name} — describe what this plugin does.
 *
 * Code plugins are trusted, in-process modules: they run with full application
 * privileges and are compiled in at build time. Import everything from the
 * stable \`astrobaas/core\` barrel, never from internal \`src/lib/*\` paths.
 *
 * See PLUGIN_DEVELOPMENT.md for the full hook catalog.
 */
export default definePlugin({
  id: '${id}',
  name: '${name}',
  version: '1.0.0',
  description: 'What ${name} does.',
  author: 'You',

  filters: {
    // Transform a value and RETURN it. Output is re-sanitized at the render
    // boundary, so you cannot smuggle unsafe HTML through this hook.
    [PLUGIN_HOOKS.POST_CONTENT]: (html: string, post?: Post) => {
      void post;
      return html;
    },

    // CSS for public pages. Served from /plugins.css — never inline it, the
    // strict CSP drops inline <style> silently.
    [PLUGIN_HOOKS.PLUGIN_STYLES]: (css: string) => css,
  },

  actions: {
    // Fire-and-forget side effects. Errors here are logged, not fatal.
    [PLUGIN_HOOKS.AFTER_POST_SAVE]: (post: Post) => {
      void post;
    },
  },
});
`;
}

export function manifestTemplate(id) {
  const name = titleize(id);
  return `${JSON.stringify(
    {
      id,
      name,
      version: '1.0.0',
      description: `What ${name} does.`,
      author: 'You',
      astrobaasApi: '^1.0.0',
      capabilities: {
        headTags: [{ tag: 'meta', attrs: { name: 'generator', content: name } }],
        css: `/* ${id} */\n.${id}-example { color: var(--primary-color); }`,
        contentTypes: [
          {
            name: `${id}-item`,
            label: `${name} Item`,
            fields: [
              { name: 'title', rule: { type: 'string', min: 1, max: 200 } },
              { name: 'body', rule: { type: 'string', max: 5000, optional: true } },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

export function themeIndexTemplate(id) {
  const name = titleize(id);
  return `import { defineTheme } from 'astrobaas/core';
import Header from './Header.astro';

/**
 * ${name} — describe the look.
 *
 * A theme overrides the slots it declares and INHERITS every other one, so it
 * stays forward-compatible when new slots are added. Drop a slot from
 * \`components\` to fall back to the built-in default.
 *
 * See THEME_DEVELOPMENT.md for the slot catalog and prop types.
 */
export default defineTheme({
  id: '${id}',
  name: '${name}',
  description: 'What ${name} looks like.',
  version: '1.0.0',
  author: 'You',
  settings: {
    colors: {
      primary: '#3B82F6',
      secondary: '#8B5CF6',
      accent: '#10B981',
      background: '#FFFFFF',
      text: '#1F2937',
    },
    typography: { headingFont: 'Inter', bodyFont: 'Inter', fontSize: '16px' },
  },
  components: { Header },
});
`;
}

export function themeHeaderTemplate(id) {
  return `---
/**
 * ${titleize(id)} — \`Header\` slot override.
 *
 * Read colors from the CSS custom properties rather than hard-coding them, so
 * an operator's customizer changes still apply.
 */
import type { HeaderProps } from 'astrobaas/core';

const { siteTitle = 'AstroBaaS' } = Astro.props as HeaderProps;
---

<header class="${id}-header bg-white border-b border-gray-200">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
    <!-- Use classes or scoped <style>, never an inline style attribute: the
         strict CSP drops those silently. -->
    <a href="/" class="text-xl font-bold">{siteTitle}</a>
    <nav class="flex gap-6 text-sm text-gray-600">
      <a href="/blog" class="hover:text-gray-900">Blog</a>
      <a href="/about" class="hover:text-gray-900">About</a>
      <a href="/contact" class="hover:text-gray-900">Contact</a>
    </nav>
  </div>
</header>
`;
}

/* ---------- writer ---------- */

/**
 * Write `files` ({ relPath: contents }) under `root`. Refuses to clobber: if any
 * target exists, nothing is written at all, so a mistyped id can't half-overwrite
 * someone's work.
 */
export function writeFiles(root, files, { force = false } = {}) {
  const targets = Object.keys(files).map((rel) => path.join(root, rel));
  if (!force) {
    const clashes = targets.filter((t) => fs.existsSync(t));
    if (clashes.length) {
      return { ok: false, error: `Refusing to overwrite:\n  ${clashes.join('\n  ')}\n(use --force to replace)` };
    }
  }
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return { ok: true, written: targets };
}

/** The one manual step: registering the new module in its static registry. */
export function registrationHint(kind, id) {
  if (kind === 'theme') {
    return [
      `Register it in src/themes/index.ts:`,
      `  import ${camel(id)}Theme from './${id}';`,
      `  export const BUNDLED_THEMES = [..., ${camel(id)}Theme];`,
      `Then rebuild — it appears in Admin → Themes.`,
    ].join('\n  ');
  }
  return [
    `Register it in src/plugins/index.ts:`,
    `  import ${camel(id)} from './${id}';`,
    `  export const BUNDLED_PLUGINS = [..., ${camel(id)}];`,
    `Then rebuild — it appears in Admin → Plugins.`,
  ].join('\n  ');
}

function camel(id) {
  return id.split('-').map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('');
}

/* ---------- shippable external package ---------- */

/**
 * The out-of-tree shape: an npm package a customer names in ASTROBAAS_PLUGINS.
 *
 * Two properties make it shippable, and both are structural rather than
 * stylistic:
 *
 *   ZERO imports from the host. The module is loaded INTO a running AstroBaaS
 *   by specifier, so anything it imported from 'astrobaas/*' would resolve
 *   against the customer's node_modules — a version it was never built with.
 *   Types come from 'astrobaas/core' as devDependency only; runtime values
 *   arrive through the factory's host argument.
 *
 *   A FACTORY default export. The loader calls it with { definePlugin,
 *   PLUGIN_HOOKS }, which is how the plugin uses host helpers without
 *   importing them. Returning a plain object (or array of them) also works.
 */
export function externalPackageJsonTemplate(id) {
  return JSON.stringify({
    name: id,
    version: '1.0.0',
    description: `${titleize(id)} — an AstroBaaS plugin.`,
    type: 'module',
    main: 'dist/index.mjs',
    files: ['dist'],
    scripts: { build: 'node build.mjs' },
    devDependencies: { esbuild: '^0.25.0' },
  }, null, 2) + '\n';
}

export function externalBuildTemplate() {
  return `import { build } from 'esbuild';

// One self-contained ESM file. bundle with no externals is deliberate:
// the output must run inside ANY AstroBaaS install with no npm install of its
// own — a customer sets ASTROBAAS_PLUGINS to this file and restarts.
await build({
  entryPoints: ['src/index.mjs'],
  outfile: 'dist/index.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
});
console.log('built dist/index.mjs');
`;
}

export function externalEntryTemplate(id) {
  const name = titleize(id);
  return `/**
 * ${name} — a shippable AstroBaaS plugin.
 *
 * Loaded with:  ASTROBAAS_PLUGINS=/path/to/dist/index.mjs   (or a package name)
 * Activated:    ASTROBAAS_PLUGINS_ACTIVATE=${id}            (or in Admin → Plugins)
 *
 * The default export is a FACTORY: the host calls it with its own helpers, so
 * this module imports NOTHING from the host at runtime. See
 * PLUGIN_DEVELOPMENT.md → "External / shippable plugins".
 */
export default function create({ definePlugin, PLUGIN_HOOKS }) {
  return definePlugin({
    id: '${id}',
    name: '${name}',
    version: '1.0.0',
    description: 'What ${name} does.',
    author: 'You',
    // Refused at load with a clear reason if the host is too old or too new.
    requiresCore: '^1.0.0',

    filters: {
      [PLUGIN_HOOKS.POST_CONTENT]: (html) => html,
    },

    routes: [
      {
        method: 'GET',
        path: '/api/plugin/${id}/status',
        access: 'staff',
        description: 'A staff-only status endpoint, as a starting point.',
        handler: async ({ store }) => {
          const seen = ((await store.get('meta', 'status-checks'))?.n ?? 0) + 1;
          await store.put('meta', 'status-checks', { n: seen });
          return new Response(JSON.stringify({ ok: true, checks: seen }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    ],

    adminPages: [
      {
        path: 'overview',
        title: '${name}',
        nav: { label: '${name}' },
        render: async () => '<h1>${name}</h1><p>Replace this screen.</p>',
      },
    ],
  });
}
`;
}

export function scaffoldExternalPackage(id, root = process.cwd()) {
  const err = validateId(id);
  if (err) return { ok: false, error: err };
  const dir = path.join(root, id);
  if (fs.existsSync(dir)) return { ok: false, error: `Directory ${id}/ already exists.` };
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), externalPackageJsonTemplate(id));
  fs.writeFileSync(path.join(dir, 'build.mjs'), externalBuildTemplate());
  fs.writeFileSync(path.join(dir, 'src', 'index.mjs'), externalEntryTemplate(id));
  return {
    ok: true,
    dir,
    next: [
      `cd ${id} && npm install && npm run build`,
      `ASTROBAAS_PLUGINS=${path.join(dir, 'dist', 'index.mjs')} ASTROBAAS_PLUGINS_ACTIVATE=${id} npm run dev`,
    ],
  };
}
