#!/usr/bin/env node
/**
 * Tests for the AstroBaaS MCP server (bin/astrobaas-mcp.mjs). Spawns the real
 * bin and speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio
 * transport), with ASTROBAAS_URL pointed at a local fake backend — so we verify
 * the handshake, tools/list, and tools/call end-to-end without the real app.
 *
 * Run with:  node tests/mcp.test.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'astrobaas-mcp.mjs');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/* ---- fake AstroBaaS backend ---- */
// Every request URL the backend saw, so a test can assert the WIRE form a tool
// sends — what the route reads — rather than only what came back.
const seen = [];
async function startFakeBackend() {
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const url = req.url || '';
      const path = url.split('?')[0];
      const m = req.method;
      if (m === 'GET' && path === '/api/auth/me')
        return send(200, { success: true, data: { id: 'apikey:1', role: 'editor', type: 'apikey' } });
      if (m === 'GET' && path === '/api/posts/missing')
        return send(404, { success: false, error: { message: 'Post not found', code: 'NOT_FOUND' } });
      if (m === 'GET' && path === '/api/posts/hello')
        return send(200, { success: true, data: { id: 'p1', title: 'Hello', slug: 'hello', content: '<p>Body</p>' } });
      if (m === 'GET' && path === '/api/posts')
        return send(200, { success: true, data: [{ id: 'p1', title: 'Hello', slug: 'hello', excerpt: 'Hi' }] });
      if (m === 'POST' && path === '/api/posts') {
        const body = JSON.parse(raw || '{}');
        return send(201, { success: true, data: { id: 'new', title: body.title, status: body.status || 'draft' } });
      }
      if (m === 'PUT' && path.startsWith('/api/posts/')) {
        const body = JSON.parse(raw || '{}');
        return send(200, { success: true, data: { id: 'p1', slug: path.split('/').pop(), ...body } });
      }
      if (m === 'DELETE' && path.startsWith('/api/posts/'))
        return send(200, { success: true, data: null });
      if (m === 'GET' && (path === '/api/products' || path === '/api/customers'))
        return send(200, { success: true, data: [], meta: {} });
      if (m === 'PUT' && /^\/api\/content\/[^/]+\/[^/]+$/.test(path))
        return send(200, { success: true, data: { id: path.split('/').pop(), data: JSON.parse(raw || '{}') } });
      if (m === 'DELETE' && /^\/api\/content\/[^/]+\/[^/]+$/.test(path))
        return send(200, { success: true, data: null });
      send(404, { success: false, error: { message: 'not found' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/* ---- MCP stdio client ---- */
function startMcp(env) {
  const child = spawn(process.execPath, [BIN], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  return {
    request(method, params) {
      const id = nextId++;
      const p = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return p;
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

async function main() {
  const backend = await startFakeBackend();
  const mcp = startMcp({ ASTROBAAS_URL: backend.url, ASTROBAAS_KEY: 'abk_test' });
  try {
    // initialize
    const init = await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    check('initialize returns serverInfo.name', init.result?.serverInfo?.name === 'astrobaas');
    check('initialize echoes a supported protocolVersion', init.result?.protocolVersion === '2024-11-05');
    check('initialize advertises tools capability', !!init.result?.capabilities?.tools);
    check('initialize advertises resources capability', !!init.result?.capabilities?.resources);
    mcp.notify('notifications/initialized', {});

    // ping
    const ping = await mcp.request('ping', {});
    check('ping returns empty result', ping.result && Object.keys(ping.result).length === 0);

    // tools/list
    const list = await mcp.request('tools/list', {});
    const names = (list.result?.tools || []).map((t) => t.name);
    check('tools/list includes whoami', names.includes('whoami'));
    check('tools/list includes the full CRUD surface',
      ['list_posts', 'get_post', 'create_post', 'update_post', 'delete_post', 'list_content', 'create_content', 'update_content', 'delete_content'].every((n) => names.includes(n)));
    check('every tool has an object inputSchema', (list.result?.tools || []).every((t) => t.inputSchema?.type === 'object'));

    // tools/call whoami
    const who = await mcp.request('tools/call', { name: 'whoami', arguments: {} });
    const whoData = JSON.parse(who.result.content[0].text);
    check('tools/call whoami hits the backend and returns role', whoData.role === 'editor' && !who.result.isError);

    // tools/call list_posts
    const posts = await mcp.request('tools/call', { name: 'list_posts', arguments: { limit: 5 } });
    const postsData = JSON.parse(posts.result.content[0].text);
    check('tools/call list_posts returns an array', Array.isArray(postsData) && postsData[0].title === 'Hello');

    // tools/call create_post
    const created = await mcp.request('tools/call', { name: 'create_post', arguments: { title: 'From MCP', status: 'draft' } });
    const createdData = JSON.parse(created.result.content[0].text);
    check('tools/call create_post posts and returns the new entity', createdData.id === 'new' && createdData.title === 'From MCP');

    // tools/call error path → isError, not a protocol error
    const missing = await mcp.request('tools/call', { name: 'get_post', arguments: { slug: 'missing' } });
    check('tools/call surfaces backend errors as isError', missing.result?.isError === true && /not found/i.test(missing.result.content[0].text));

    // unknown tool → JSON-RPC error
    const badTool = await mcp.request('tools/call', { name: 'nope', arguments: {} });
    check('tools/call unknown tool → JSON-RPC error -32602', badTool.error?.code === -32602);

    // tools/call update_post (PUT by ref)
    const upd = await mcp.request('tools/call', { name: 'update_post', arguments: { ref: 'hello', status: 'published' } });
    const updData = JSON.parse(upd.result.content[0].text);
    check('tools/call update_post PUTs and returns the entity', !upd.result.isError && updData.status === 'published' && updData.slug === 'hello');

    // tools/call delete_post (DELETE by ref)
    const del = await mcp.request('tools/call', { name: 'delete_post', arguments: { ref: 'hello' } });
    check('tools/call delete_post succeeds', !del.result?.isError);

    // tools/call delete_content
    const delc = await mcp.request('tools/call', { name: 'delete_content', arguments: { type: 'product', id: 'x1' } });
    check('tools/call delete_content succeeds', !delc.result?.isError);

    // resources/list → posts as resources
    const reslist = await mcp.request('resources/list', {});
    const resources = reslist.result?.resources || [];
    check('resources/list exposes posts as astrobaas://post/ URIs', resources.length === 1 && resources[0].uri === 'astrobaas://post/hello' && resources[0].name === 'Hello');

    // resources/read → a post's content
    const read = await mcp.request('resources/read', { uri: 'astrobaas://post/hello' });
    check('resources/read returns the post content', read.result?.contents?.[0]?.text === '<p>Body</p>' && read.result.contents[0].uri === 'astrobaas://post/hello');

    // resources/read unknown URI → JSON-RPC error
    const badRead = await mcp.request('resources/read', { uri: 'astrobaas://nope/x' });
    check('resources/read unknown URI → -32602', badRead.error?.code === -32602);

    // ---- query flags: what each list tool puts on the wire ----
    // The products route reads `featured` as a filter only when it is `true`;
    // anything else means "no filter". So `featured: false` must not be sent —
    // `featured=false` reads like "only non-featured" and silently returns all.
    const wire = async (name, args, routePath) => {
      seen.length = 0;
      const r = await mcp.request('tools/call', { name, arguments: args });
      const hit = seen.find((l) => l.startsWith(`GET ${routePath}`));
      return { ok: !r.result?.isError, qs: hit ? new URLSearchParams(hit.split('?')[1] ?? '') : null };
    };
    {
      const f = await wire('list_products', { featured: false, limit: 5 }, '/api/products');
      check('list_products featured:false sends NO featured param (false = no filter)',
        f.ok && f.qs && !f.qs.has('featured') && f.qs.get('limit') === '5');
      const t = await wire('list_products', { featured: true }, '/api/products');
      check('list_products featured:true sends featured=true, the value the route filters on',
        t.ok && t.qs?.get('featured') === 'true');
      const n = await wire('list_products', {}, '/api/products');
      check('list_products with no featured sends no featured param', n.ok && n.qs && !n.qs.has('featured'));
      const desc = (list.result?.tools || []).find((x) => x.name === 'list_products')
        ?.inputSchema?.properties?.featured?.description ?? '';
      check('list_products documents that featured:false is no filter', /false[^.]*no featured filter/i.test(desc));
    }
    // ---- list_customers pages like list_orders ----
    {
      const c = await wire('list_customers', { search: 'maria', limit: 10, offset: 20 }, '/api/customers');
      check('list_customers sends search, limit and offset',
        c.ok && c.qs?.get('search') === 'maria' && c.qs.get('limit') === '10' && c.qs.get('offset') === '20');
      const d = await wire('list_customers', {}, '/api/customers');
      check('list_customers with no arguments sends no query string', d.ok && d.qs && [...d.qs.keys()].length === 0);
      const schema = (list.result?.tools || []).find((x) => x.name === 'list_customers')?.inputSchema?.properties ?? {};
      check('list_customers accepts offset, so an agent can page past the first 50',
        schema.offset?.type === 'integer' && schema.limit?.maximum === 200);
    }

    // unknown method → method-not-found
    const badMethod = await mcp.request('frobnicate', {});
    check('unknown method → -32601', badMethod.error?.code === -32601);
  } finally {
    mcp.close();
    await backend.close();
  }

  /* ---- drift guard: every tool must point at a route that EXISTS ----
   * An MCP tool whose endpoint was renamed fails only when an agent calls it,
   * at which point the agent gets an opaque 404 and no way to tell that the
   * tool is wrong rather than its arguments. This caught exactly that: a
   * `PUT /api/plugins/{id}` tool for a route that is really
   * `POST /api/plugins/toggle`. */
  {
    const src = fs.readFileSync(path.join(here, '..', 'bin/astrobaas-mcp.mjs'), 'utf8');
    const apiRoot = path.join(here, '..', 'src/pages/api');

    // Pull the whole path expression out of each apiRequest() call, then
    // normalise `${...}` interpolations to '*' — an interpolated segment is a
    // dynamic route param, which must match a [param] file or directory.
    const refs = [...src.matchAll(/apiRequest\(\s*'(GET|POST|PUT|DELETE)'\s*,\s*[`']([^`']+)[`']/g)]
      .map((m) => ({
        method: m[1],
        path: m[2]
          .replace(/\$\{[^}{]*\}/g, '*')  // interpolation -> dynamic segment
          // A NESTED template (`...${q ? `?${q}` : ''}`) is an optional query
          // string; truncate at it — the path before it is what routes.
          .replace(/\$.*$/, '')
          .split('?')[0]
          .replace(/^\/api\//, '')
          .replace(/\/+$/, ''),
      }))
      .filter((r) => r.path.length > 0);

    const routeExists = (p) => {
      const segs = p.split('/').filter(Boolean);
      const walk = (dir, i) => {
        if (i === segs.length) {
          return fs.existsSync(`${dir}.ts`) || fs.existsSync(path.join(dir, 'index.ts'));
        }
        if (!fs.existsSync(dir)) return false;
        const seg = segs[i];
        // A literal segment may match its own name...
        if (seg !== '*') {
          const exact = path.join(dir, seg);
          if ((fs.existsSync(exact) || fs.existsSync(`${exact}.ts`)) && walk(exact, i + 1)) return true;
        }
        // ...and either kind may match a [param] route.
        for (const entry of fs.readdirSync(dir)) {
          if (!entry.startsWith('[')) continue;
          const cand = path.join(dir, entry.replace(/\.ts$/, ''));
          if (walk(cand, i + 1)) return true;
        }
        return false;
      };
      return walk(apiRoot, 0);
    };

    // Plugin-owned routes are not files: they are declared in the plugin's
    // routes module as r('METHOD', '/path', …) under /api/plugin/<id>/.
    const pluginRoutes = [];
    for (const dir of fs.readdirSync(path.join(apiRoot, '..', '..', 'plugins'))) {
      const file = path.join(apiRoot, '..', '..', 'plugins', dir, 'routes.ts');
      if (!fs.existsSync(file)) continue;
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/\br\('(GET|POST|PUT|PATCH|DELETE)',\s*'([^']+)'/g)) {
        pluginRoutes.push({ method: m[1], re: new RegExp(`^plugin/${dir}${m[2].replace(/:[a-z_]+/g, '[^/]+').replace(/\//g, '\\/')}$`) });
      }
    }
    const pluginRouteExists = (method, p) => pluginRoutes.some((r) => r.method === method && r.re.test(p.replace(/\*/g, 'x')));
    const missing = [];
    for (const r of refs) {
      const ok = r.path.startsWith('plugin/') ? pluginRouteExists(r.method, r.path) : routeExists(r.path);
      if (!ok) missing.push(`${r.method} /api/${r.path}`);
    }
    check(`every MCP tool targets an existing route${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
      missing.length === 0);
    check('the tool surface covers commerce, media and settings', (() => {
      const names = [...src.matchAll(/^\s{4}name: '([a-z_]+)'/gm)].map((m) => m[1]);
      return ['list_products', 'create_product', 'list_orders', 'set_order_status',
        'list_customers', 'list_media', 'get_settings', 'list_payment_methods']
        .every((n) => names.includes(n));
    })());
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
