import { definePlugin, PLUGIN_HOOKS, countWords } from 'astrobaas/core';

/**
 * Reading time — prepends an estimated read time to post content. Demonstrates
 * a value-transforming `post_content` filter. Output is allow-list-safe (a <p>
 * with a class), so it survives the render-boundary re-sanitization.
 *
 * Note how a plugin imports everything it needs from the stable `astrobaas/core`
 * barrel — never from internal `src/lib/*` paths.
 */
function estimateMinutes(html: string): number {
  // countWords comes from the barrel, so this plugin's number and the byline's
  // are computed by the same stripper. The private copy that used to live here
  // was one of five, two of which disagreed about whether a tag boundary is a
  // word boundary — so `<b>ten</b><b>words</b>` counted differently depending
  // on which one you asked.
  return Math.max(1, Math.ceil(countWords(html) / 200));
}

export default definePlugin({
  id: 'reading-time',
  name: 'Reading Time',
  version: '1.0.0',
  description: 'Adds an estimated reading time to the top of each post.',
  author: 'AstroBaaS',
  filters: {
    [PLUGIN_HOOKS.POST_CONTENT]: (html: string) => {
      if (typeof html !== 'string' || !html.trim()) return html;
      const mins = estimateMinutes(html);
      return `<p class="reading-time">⏱ ${mins} min read</p>${html}`;
    },
  },
});
