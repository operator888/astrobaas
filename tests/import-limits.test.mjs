#!/usr/bin/env node
/**
 * The two body limits on the import route, and the relationship between them.
 *
 * This exists because of a bug that was in the branch for about ten minutes
 * and would have been invisible in review: the route refused files over 24 MB
 * with a message telling the operator to use the CLI, while the middleware
 * refused every body over the 2 MB DEFAULT before the route ever ran. Both
 * files were correct on their own. The operator would have got a bare 413 and
 * no idea the CLI existed.
 *
 * So this asserts the RELATIONSHIP rather than either number, and that the
 * middleware is actually wired to the shared constant instead of a literal
 * that can drift away from it.
 *
 * Run with:  node tests/import-limits.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-implimits-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/import/limits.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const L = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

// The table that now owns the transport ceiling, loaded the same way.
const blOut = path.join(cacheDir, `astrobaas-bodylimits-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/body-limits.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: blOut, logLevel: 'silent',
});
const BL = await import(pathToFileURL(blOut).href);
await fs.rm(blOut, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const middleware = await fs.readFile(path.join(root, 'src/middleware.ts'), 'utf8');
const bodyLimits = await fs.readFile(path.join(root, 'src/lib/body-limits.ts'), 'utf8');
const route = await fs.readFile(path.join(root, 'src/pages/api/import/wordpress.ts'), 'utf8');

/* ---- the relationship ---- */
check('the transport limit is strictly larger than the file limit — multipart '
  + 'framing counts toward Content-Length, so an export of exactly the '
  + 'documented maximum must still get through',
  L.IMPORT_BODY_LIMIT > L.MAX_HTTP_WXR_BYTES);

check('...with enough headroom for the form fields around the file',
  L.IMPORT_BODY_LIMIT - L.MAX_HTTP_WXR_BYTES >= 1024 * 1024);

check('the HTTP cap stays well under the parser\'s own ceiling, so the route '
  + 'is the layer that answers', L.MAX_HTTP_WXR_BYTES < 200 * 1024 * 1024);

check('the media cap is a real bound, not a placeholder',
  Number.isInteger(L.HTTP_MEDIA_CAP) && L.HTTP_MEDIA_CAP > 0 && L.HTTP_MEDIA_CAP <= 1000);

/* ---- the wiring, which is where the drift would happen ---- */
/*
 * The per-route ceilings moved from a chain of `if`s in the middleware into
 * `lib/body-limits.ts`, because a reverse proxy in front of the app has its own
 * cap and refuses the request first — so the numbers had to become readable by
 * something that can check the shipped nginx and Caddy configs against them.
 *
 * The property these assertions defend did not change: the ceiling comes from
 * the shared constant rather than a literal that can drift from it, and the
 * middleware still enforces it. Only its address did.
 */
check('/api/import/wordpress has a ceiling of its own at all',
  /\/api\/import\/wordpress/.test(bodyLimits));

check('...taken from the shared constant rather than a literal that can drift',
  /bytes: IMPORT_BODY_LIMIT,/.test(bodyLimits));

check('...imported from the module that defines it',
  /import \{[^}]*IMPORT_BODY_LIMIT[^}]*\} from '\.\/import\/limits'/.test(bodyLimits));

check('the middleware still ENFORCES the table, rather than merely owning it',
  /import \{ bodyLimitFor \} from '\.\/lib\/body-limits'/.test(middleware)
  && /declared > bodyLimitFor\(pathname\)/.test(middleware));

// The value itself, not just the wiring — a regex over source proves the shape
// and nothing about the number it produces.
check('and the ceiling it actually returns is the shared constant',
  BL.bodyLimitFor('/api/import/wordpress') === L.IMPORT_BODY_LIMIT);

check('the route enforces the file cap from the same module, not its own copy',
  /from '\.\.\/\.\.\/\.\.\/lib\/import\/limits'/.test(route)
  && !/const MAX_HTTP_WXR_BYTES =/.test(route));

check('the oversize message names the way out, because a limit with no '
  + 'alternative is just a wall', /scripts\/import-wp\.mjs/.test(route));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
