#!/usr/bin/env node
/**
 * Unit tests for the plugin manager (src/lib/plugin-system.ts). Transpiles the
 * TS source in-process (it has no runtime imports) and exercises the full
 * lifecycle: register → activate → filter/action fire → deactivate → bootstrap.
 *
 * Run with:  npm run test:plugins
 */
import { transform } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'lib', 'plugin-system.ts');
const { code } = await transform(await fs.readFile(srcPath, 'utf8'), { loader: 'ts', format: 'esm' });
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const tmp = path.join(cacheDir, `astrocms-plugins-${process.pid}.mjs`);
await fs.writeFile(tmp, code);
const mod = await import(pathToFileURL(tmp).href);
await fs.rm(tmp, { force: true });

const { PluginManager, PLUGIN_HOOKS } = mod;

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// --- catalog ---
check('PLUGIN_HOOKS has the live filter names', PLUGIN_HOOKS.POST_CONTENT === 'post_content' && PLUGIN_HOOKS.API_POSTS_GET === 'api_posts_get');
check('PLUGIN_HOOKS exposes the lifecycle/render hooks', PLUGIN_HOOKS.BEFORE_POST_SAVE === 'before_post_save' && PLUGIN_HOOKS.AFTER_POST_SAVE === 'after_post_save' && PLUGIN_HOOKS.HEAD_TAGS === 'head_tags');

// --- before_post_save can mutate the draft + receives the ctx arg ---
const pmSave = new PluginManager();
pmSave.registerPlugin({
  id: 'tagger', name: '', version: '1', description: '', author: '',
  filters: {
    [PLUGIN_HOOKS.BEFORE_POST_SAVE]: (post, ctx) => ({ ...post, meta_title: ctx?.isNew ? 'new' : 'edit' }),
  },
});
pmSave.activatePlugin('tagger');
check('before_post_save mutates draft (isNew=true)', pmSave.applyFilters('before_post_save', { title: 'x' }, { isNew: true }).meta_title === 'new');
check('before_post_save sees ctx (isNew=false)', pmSave.applyFilters('before_post_save', { title: 'x' }, { isNew: false }).meta_title === 'edit');

// --- head_tags filter accumulates contributed markup ---
const pmHead = new PluginManager();
pmHead.registerPlugin({
  id: 'meta', name: '', version: '1', description: '', author: '',
  filters: { [PLUGIN_HOOKS.HEAD_TAGS]: (html) => html + '<meta name="x" content="y">' },
});
pmHead.activatePlugin('meta');
check('head_tags filter contributes markup', pmHead.applyFilters('head_tags', '', { pathname: '/' }) === '<meta name="x" content="y">');

// --- filter lifecycle ---
const pm = new PluginManager();
const plugin = {
  id: 'upper',
  name: 'Upper',
  version: '1.0.0',
  description: '',
  author: '',
  filters: { [PLUGIN_HOOKS.POST_TITLE]: (t) => String(t).toUpperCase() },
};
pm.registerPlugin(plugin);

check('filter is a no-op before activation', pm.applyFilters('post_title', 'hello') === 'hello');
pm.activatePlugin('upper');
check('filter transforms after activation', pm.applyFilters('post_title', 'hello') === 'HELLO');
check('isPluginActive reflects state', pm.isPluginActive('upper') === true);
pm.deactivatePlugin('upper');
check('filter is a no-op after deactivation', pm.applyFilters('post_title', 'hello') === 'hello');

// --- filter ordering + extra args ---
const pm2 = new PluginManager();
pm2.registerPlugin({ id: 'a', name: 'a', version: '1', description: '', author: '', filters: { post_content: (h) => h + '<a>' } });
pm2.registerPlugin({ id: 'b', name: 'b', version: '1', description: '', author: '', filters: { post_content: (h, post) => h + (post?.status ?? '') } });
pm2.activatePlugin('a');
pm2.activatePlugin('b');
check('filters chain in activation order with args', pm2.applyFilters('post_content', 'x', { status: 'draft' }) === 'x<a>draft');

// --- error isolation ---
const pm3 = new PluginManager();
pm3.registerPlugin({ id: 'boom', name: '', version: '1', description: '', author: '', filters: { post_title: () => { throw new Error('boom'); } } });
pm3.activatePlugin('boom');
check('throwing filter passes input through', pm3.applyFilters('post_title', 'safe') === 'safe');

// --- actions ---
const pm4 = new PluginManager();
let fired = null;
pm4.registerPlugin({ id: 'log', name: '', version: '1', description: '', author: '', actions: { after_post_save: (p) => { fired = p.id; } } });
pm4.activatePlugin('log');
pm4.doAction('after_post_save', { id: 'p1' });
check('action fires with args', fired === 'p1');

// --- bootstrap activates only persisted-active plugins ---
const pm5 = new PluginManager();
const plugins = [
  { id: 'on', name: '', version: '1', description: '', author: '', filters: { post_title: (t) => t + '!' } },
  { id: 'off', name: '', version: '1', description: '', author: '', filters: { post_title: (t) => t + '?' } },
];
await pm5.bootstrap(plugins, async () => new Set(['on']));
check('bootstrap activates persisted-active', pm5.applyFilters('post_title', 'hi') === 'hi!');
check('bootstrap leaves others inactive', pm5.isPluginActive('off') === false);
await pm5.bootstrap(plugins, async () => new Set(['on', 'off']));
check('bootstrap is idempotent (no double-activate)', pm5.applyFilters('post_title', 'hi') === 'hi!');

// --- a plugin id registered twice is survivable, but must not be silent ---
//
// The registry is a Map, so the later registration wins and the earlier one
// vanishes without a word. That became likely the moment a customer could
// install both a single module and a bundle that contains it: which VERSION of
// the code runs then depends on load order, and nothing says so.
{
  const pm6 = new PluginManager();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    pm6.registerPlugin({ id: 'dup', name: '', version: '1.0.0', description: '', author: '', filters: { post_title: (t) => t + '[a]' } });
    pm6.registerPlugin({ id: 'dup', name: '', version: '2.0.0', description: '', author: '', filters: { post_title: (t) => t + '[b]' } });
  } finally {
    console.warn = realWarn;
  }
  check('a duplicate id warns', warnings.length === 1);
  check('the warning names the plugin and BOTH versions',
    warnings[0].includes('"dup"') && warnings[0].includes('1.0.0') && warnings[0].includes('2.0.0'));

  pm6.activatePlugin('dup');
  check('the LAST registration is the one that runs', pm6.applyFilters('post_title', 'x') === 'x[b]');
  check('and it runs once, not twice', pm6.applyFilters('post_title', 'x').split('[').length === 2);

  // Registering distinct ids must stay silent, or the warning is noise.
  const pm7 = new PluginManager();
  const quiet = [];
  console.warn = (...a) => quiet.push(a.join(' '));
  try {
    pm7.registerPlugin({ id: 'a', name: '', version: '1', description: '', author: '' });
    pm7.registerPlugin({ id: 'b', name: '', version: '1', description: '', author: '' });
  } finally {
    console.warn = realWarn;
  }
  check('distinct ids do not warn', quiet.length === 0);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
