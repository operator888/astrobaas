/**
 * Keep uploaded files out of the build output.
 *
 * Uploads default to `public/uploads` (src/lib/paths.ts), and `astro build`
 * copies all of `public/` into `dist/client`. The node adapter serves
 * `dist/client` BEFORE the app and its middleware run, so every upload that
 * happened to be on disk at build time was served from the copy with none of
 * the app's headers — no `nosniff`, no sandbox CSP on SVG, no X-Frame-Options —
 * and newer uploads, missing from the copy, from the app's route with them.
 * It also shipped whatever was in the working tree's uploads inside a release.
 *
 * Removing them after the build leaves `/uploads/*` to its own route
 * (src/pages/uploads/[...path].ts), which reads UPLOADS_DIR and sets the
 * headers, for every file, however old. `.gitkeep` stays; it is not an upload.
 * tests/build-uploads.test.mjs covers it.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

/** Remove everything under `<clientDir>/uploads` except `.gitkeep`; returns what went. */
export function stripBuiltUploads(clientDir: string): string[] {
  const dir = path.join(clientDir, 'uploads');
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '.gitkeep') continue;
    rmSync(path.join(dir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

export function stripBuiltUploadsIntegration(): AstroIntegration {
  let clientDir = '';
  return {
    name: 'astrobaas:strip-built-uploads',
    hooks: {
      'astro:config:done': ({ config }) => {
        clientDir = fileURLToPath(config.build.client);
      },
      'astro:build:done': ({ logger }) => {
        const removed = stripBuiltUploads(clientDir);
        if (removed.length) {
          logger.info(`kept ${removed.length} upload entr${removed.length === 1 ? 'y' : 'ies'} out of the build — `
            + '/uploads is served by the app, with its security headers');
        }
      },
    },
  };
}
