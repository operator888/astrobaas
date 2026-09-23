import { definePlugin, PLUGIN_HOOKS } from 'astrobaas/core';
import type { Post } from 'astrobaas/core';

/**
 * Draft watermark — prepends a visible banner to any post whose status is not
 * `published`. Demonstrates a per-post conditional `post_content` filter that
 * uses the second filter argument (the post record).
 */
export default definePlugin({
  id: 'draft-watermark',
  name: 'Draft Watermark',
  version: '1.0.0',
  description: 'Shows a "DRAFT" banner on the content of non-published posts.',
  author: 'AstroBaaS',
  filters: {
    [PLUGIN_HOOKS.POST_CONTENT]: (html: string, post?: Post) => {
      if (typeof html !== 'string') return html;
      if (post && post.status && post.status !== 'published') {
        return `<p class="draft-banner"><strong>DRAFT</strong> — this content is not published.</p>${html}`;
      }
      return html;
    },
  },
});
