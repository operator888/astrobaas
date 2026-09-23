import { definePlugin, PLUGIN_HOOKS } from 'astrobaas/core';

/**
 * Print Styles — makes article pages print cleanly: hides chrome (nav, footer,
 * forms), drops backgrounds, and prints link targets after the anchor text.
 *
 * This is the reference example for the `plugin_styles` hook — the supported way
 * for a plugin to contribute CSS. The returned CSS is concatenated with every
 * other active plugin's and served from /plugins.css, which satisfies the strict
 * `style-src 'self'` CSP. (An inline <style> would be silently dropped by the
 * browser, so `head_tags` accepts meta/link only.)
 */
// The leading marker doubles as a stable sentinel for tests asserting that this
// CSS is SERVED (from /plugins.css) rather than inlined into <head>.
const PRINT_CSS = `/* astrobaas:print-styles */
@media print{
header nav,footer,form{display:none!important}
body{background:#fff!important;color:#000!important}
a[href^="http"]:after{content:" (" attr(href) ")";font-size:0.85em;word-break:break-all}
article,main{width:100%!important;max-width:none!important;padding:0!important}
}`;

export default definePlugin({
  id: 'print-styles',
  name: 'Print Styles',
  version: '1.0.0',
  description: 'Adds a print stylesheet so articles print without site chrome.',
  author: 'AstroBaaS',
  filters: {
    [PLUGIN_HOOKS.PLUGIN_STYLES]: (css: string) => `${css}\n${PRINT_CSS}`,
  },
});
