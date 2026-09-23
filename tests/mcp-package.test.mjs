#!/usr/bin/env node
/**
 * The standalone `astrobaas-mcp` npm package works the way an MCP client uses
 * it: installed on its own, into a directory with no AstroBaaS in it, and
 * started by its bin name.
 *
 * What it guards:
 *  - `npx astrobaas-mcp` resolves a PACKAGE, so the bin inside `astrobaas` is
 *    no use to an MCP client config. This package is that name.
 *  - It is staged by scripts/build-mcp-pkg.mjs from bin/. A server file that
 *    imports a new sibling would pass tests/mcp.test.mjs in the repo and crash
 *    on import from the tarball — so this installs the real tarball, offline
 *    (zero dependencies is part of the contract), and speaks MCP to it.
 *  - It is the SAME server: the tool list must equal the in-repo binary's.
 *
 * Run with:  node tests/mcp-package.test.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'packages/astrobaas-mcp');

let pass = 0;
let fail = 0;
const check = (n, c, detail = '') => {
  if (c) pass++;
  else { fail++; console.error(`✗ ${n}${detail ? `: ${detail}` : ''}`); }
};

/** Start an MCP server, send initialize + tools/list, return the two results. */
function handshake(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ASTROBAAS_URL: 'http://127.0.0.1:9' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const results = new Map();
    let buf = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no answer from ${args.join(' ')}:\n${err}`)); }, 15_000);
    child.stderr.on('data', (c) => (err += c));
    child.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id != null) results.set(msg.id, msg.result ?? msg.error);
        if (results.size === 2) { clearTimeout(timer); child.kill(); resolve(results); }
      }
    });
    child.on('error', reject);
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abmcp-'));
try {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-mcp-pkg.mjs')], { stdio: 'pipe' });

  const rootVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  check('the package is named for what npx resolves', manifest.name === 'astrobaas-mcp');
  check('its version is the release version', manifest.version === rootVersion, `${manifest.version} vs ${rootVersion}`);
  check('it has no dependencies, so npx starts it without an install tree',
    !manifest.dependencies && !manifest.peerDependencies && !manifest.optionalDependencies);
  check('the staged server is byte-identical to bin/astrobaas-mcp.mjs',
    fs.readFileSync(path.join(pkgDir, 'astrobaas-mcp.mjs'), 'utf8') === fs.readFileSync(path.join(root, 'bin/astrobaas-mcp.mjs'), 'utf8'));

  const tgzName = execFileSync('npm', ['pack', pkgDir, '--pack-destination', tmp, '--silent'], { encoding: 'utf8' }).trim().split('\n').pop();
  const tgz = path.join(tmp, tgzName);
  const listed = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  const expected = ['package/LICENSE', 'package/README.md', 'package/astrobaas-mcp.mjs', 'package/lib/api-client.mjs', 'package/package.json'];
  check('the tarball holds the server, its import, the licence and nothing else',
    JSON.stringify(listed) === JSON.stringify(expected), listed.join(', '));

  // An empty project: no AstroBaaS, no network.
  const consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), '{"name":"consumer","private":true}');
  execFileSync('npm', ['install', '--offline', '--no-audit', '--no-fund', '--silent', tgz], { cwd: consumer, stdio: 'pipe' });
  const bin = path.join(consumer, 'node_modules/.bin/astrobaas-mcp');
  check('installing it creates the astrobaas-mcp command', fs.existsSync(bin));
  check('it installs alone', fs.readdirSync(path.join(consumer, 'node_modules')).filter((d) => !d.startsWith('.')).join() === 'astrobaas-mcp');

  const installed = await handshake(bin, [], consumer);
  const inRepo = await handshake(process.execPath, [path.join(root, 'bin/astrobaas-mcp.mjs')], root);
  check('the installed server answers initialize', installed.get(1)?.serverInfo?.name === 'astrobaas',
    JSON.stringify(installed.get(1)));
  const names = (r) => (r.get(2)?.tools ?? []).map((t) => t.name).sort().join(',');
  check('it lists tools', names(installed).length > 0);
  check('it is the same server as the in-repo binary', names(installed) === names(inRepo),
    `${names(installed)} vs ${names(inRepo)}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
