import type { APIRoute } from 'astro';
import { pluginManager, PLUGIN_HOOKS } from '../lib/plugin-system';
import { ensurePluginsBootstrapped } from '../plugins';
import { LocalDB } from '../lib/localdb';
import { isDeclarativeRecord } from '../lib/manifest-runtime';
import { manifestSectionCss } from '../lib/manifest-sections';

/**
 * CSS contributed by active plugins (the `plugin_styles` hook), served as one
 * same-origin stylesheet.
 *
 * Plugins can't ship a `<style>` tag: the app runs a hash-based CSP with no
 * `'unsafe-inline'`, and per-request markup has no build-time hash, so the
 * browser silently refuses it. (Astro's CSP runtime API can't rescue that
 * either — the Node adapter streams, so the CSP header is finalized before the
 * layout renders.) Serving the CSS from our own origin satisfies `style-src
 * 'self'` and keeps the policy strict.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  let css = '';
  try {
    await ensurePluginsBootstrapped();
    css = String(
      pluginManager.applyFilters(PLUGIN_HOOKS.PLUGIN_STYLES, '', { pathname: url.pathname }) ?? '',
    );
  } catch (err) {
    // A broken plugin must not take down page styling — serve nothing.
    console.error('plugins.css build error:', err);
    css = '';
  }

  // Section styles from installed manifests. Appended here rather than given
  // their own route so a page still fetches one plugin stylesheet, and gathered
  // per active plugin so uninstalling one takes its styles with it — the
  // markup stays in content and simply goes unstyled, which is the same
  // degradation core sections rely on.
  try {
    for (const record of await LocalDB.getPlugins()) {
      if (!record.active) continue;
      if (!isDeclarativeRecord(record.settings)) continue;
      const sectionCss = manifestSectionCss(record.settings.manifest);
      if (sectionCss) css += `\n${sectionCss}\n`;
    }
  } catch (err) {
    console.error('plugins.css section styles error:', err);
  }

  // Defensive: CSS is same-origin and non-executable, but keep a plugin from
  // closing the context and smuggling markup if this is ever inlined.
  css = css.replace(/<\/?(style|script)\b/gi, '');

  return new Response(css, {
    status: 200,
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      // Activating/deactivating a plugin must take effect on the next load.
      'Cache-Control': 'no-cache',
    },
  });
};
