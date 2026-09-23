#!/usr/bin/env node
/**
 * Stage the standalone `astrobaas-mcp` npm package in packages/astrobaas-mcp/.
 *
 * Why a second package: `npx astrobaas-mcp` resolves a PACKAGE name, not a bin
 * name, so the `astrobaas-mcp` binary inside `astrobaas` is unreachable from an
 * MCP client config on a machine that has not installed AstroBaaS — which is
 * the normal case. The server is written with zero dependencies precisely so it
 * can run from npx; publishing it inside `astrobaas` would make npx fetch
 * Astro, sharp and the rest to start a stdio process that uses none of them.
 *
 * Why copied, not written twice: there is ONE server, `bin/astrobaas-mcp.mjs`,
 * tested by tests/mcp.test.mjs. This copies it and its one sibling import
 * verbatim, and takes the version from the root package.json, so the two
 * packages cannot drift. The copies are gitignored; the publish workflow runs
 * this before `npm publish ./packages/astrobaas-mcp`.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'packages/astrobaas-mcp');

rmSync(path.join(out, 'lib'), { recursive: true, force: true });
mkdirSync(path.join(out, 'lib'), { recursive: true });

copyFileSync(path.join(root, 'bin/astrobaas-mcp.mjs'), path.join(out, 'astrobaas-mcp.mjs'));
copyFileSync(path.join(root, 'bin/lib/api-client.mjs'), path.join(out, 'lib/api-client.mjs'));
copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const pkgPath = path.join(out, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

console.log(`staged astrobaas-mcp@${version} in packages/astrobaas-mcp/`);
