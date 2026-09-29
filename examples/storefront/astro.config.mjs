// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

/*
 * A static site: every page is built from the CMS at build time, and the only
 * things that happen in the browser are the cart and the checkout, which call
 * the CMS directly. Rebuild when the catalogue changes — see README.md.
 */
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '');
const cms = (env.PUBLIC_CMS_URL ?? '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(cms)) {
  throw new Error(
    `PUBLIC_CMS_URL must be the CMS origin, like https://cms.example.com — got "${env.PUBLIC_CMS_URL ?? ''}". ` +
    'Copy .env.example to .env and set it.',
  );
}

export default defineConfig({
  output: 'static',
  site: env.STOREFRONT_URL || undefined,
  build: { format: 'directory' },
  security: {
    /*
     * A strict Content-Security-Policy, as a <meta> tag on every page: scripts
     * and styles only from this site, by hash, and no 'unsafe-inline'. The CMS
     * is the one other origin the page may talk to (the cart and checkout).
     * Images may come from any https origin, because a CMS with MEDIA_BASE set
     * serves product photos from a CDN. A host that can send headers should
     * ALSO send `frame-ancestors 'none'`, which a <meta> policy cannot carry.
     */
    csp: {
      directives: [
        "default-src 'self'",
        `img-src 'self' data: https: ${cms}`,
        `connect-src 'self' ${cms}`,
        "object-src 'none'",
        "base-uri 'self'",
        `form-action 'self'`,
      ],
    },
  },
});
