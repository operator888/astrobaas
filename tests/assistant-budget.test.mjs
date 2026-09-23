#!/usr/bin/env node
/**
 * The public AI assistant has a daily spend ceiling (S5.9).
 *
 * ## The bug
 *
 * `POST /api/assistant/chat` is anonymous, and every call is billed to the
 * operator's own provider account. The only limit was the middleware's 60
 * writes a minute per IP — 86,400 paid completions a day from one address.
 *
 * ## What is asserted
 *
 *   - the budget resolver: defaults, `0` = off, nonsense and negatives are not
 *     "off";
 *   - the counter: per IP first, then site-wide, and an IP over its own
 *     allowance does not spend the site's;
 *   - the ROUTE, for real, with the provider stubbed at `fetch`: past the cap
 *     the provider is NOT called, the refusal is the plugin's own error
 *     envelope with a Retry-After, and an invalid message does not spend.
 *
 * Run with:  node tests/assistant-budget.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

/* ---------------------------------------------------------------- child --- */
if (process.env.ASSISTANT_BUDGET_CHILD) {
  const entry = path.join(ROOT, 'node_modules', '.cache', `assistant-budget-entry-${process.pid}.ts`);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
    `export { POST } from ${abs('src/pages/api/assistant/chat.ts')};`,
  ].join('\n'));
  let M;
  try {
    M = await loadTs(path.relative(ROOT, entry), 'assistantbudget');
  } finally {
    await fs.rm(entry, { force: true });
  }
  const { LocalDB, POST } = M;
  await LocalDB.init();
  for (const [k, v] of Object.entries({
    assistant_enabled: true,
    assistant_provider: 'openai-compatible',
    assistant_base_url: 'https://llm.invalid/v1',
    assistant_model: 'test-model',
    assistant_api_key: 'test-key-123456',
    // Small, so the test reaches both ceilings quickly.
    assistant_daily_message_cap: 5,
    assistant_daily_ip_cap: 3,
  })) await LocalDB.updateSetting(k, v);

  let providerCalls = 0;
  globalThis.fetch = async (url) => {
    providerCalls += 1;
    if (!String(url).startsWith('https://llm.invalid/')) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello from the stub' } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  const chat = async (ip, message = 'Do you have size 52?') => {
    const url = new URL('http://cms.test/api/assistant/chat');
    const res = await POST({
      url, params: {}, locals: { user: null, ip },
      request: new Request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, retryAfter: res.headers.get('retry-after'), calls: providerCalls };
  };

  const out = {};
  // An invalid message spends nothing.
  out.empty = await chat('10.3.0.1', '   ');
  // One IP: three answers, then refused — and the provider is not called.
  out.a = [];
  for (let i = 0; i < 4; i += 1) out.a.push(await chat('10.3.0.1'));
  // Other IPs share the site's five: two more answers, then the site is spent.
  out.b = await chat('10.3.0.2');
  out.c = await chat('10.3.0.3');
  out.d = await chat('10.3.0.4');
  out.providerCalls = providerCalls;
  console.log('__RESULT__' + JSON.stringify(out));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

{
  const B = await loadTs('src/lib/assistant-budget.ts');
  const RL = await loadTs('src/lib/rate-limit.ts');

  const d = B.resolveAssistantBudget({});
  check('defaults: 500 a day site-wide, 50 per IP', d.siteDaily === 500 && d.ipDaily === 50);
  check('0 switches a cap off',
    B.resolveAssistantBudget({ assistant_daily_message_cap: 0 }).siteDaily === null
    && B.resolveAssistantBudget({ assistant_daily_ip_cap: '0' }).ipDaily === null);
  check('a TEXT-stored number is read', B.resolveAssistantBudget({ assistant_daily_message_cap: '20' }).siteDaily === 20);
  check('nonsense is the default, not off',
    B.resolveAssistantBudget({ assistant_daily_message_cap: 'lots' }).siteDaily === 500);
  check('a negative is the default, not off',
    B.resolveAssistantBudget({ assistant_daily_ip_cap: -1 }).ipDaily === 50);

  const store = new RL.MemoryRateLimitStore();
  const budget = { siteDaily: 3, ipDaily: 2 };
  const r = [];
  r.push(await B.spendAssistantMessage(budget, '1.1.1.1', store));
  r.push(await B.spendAssistantMessage(budget, '1.1.1.1', store));
  r.push(await B.spendAssistantMessage(budget, '1.1.1.1', store));
  check('an IP gets its allowance', r[0].ok && r[1].ok);
  check('...and is then refused, naming the IP budget', !r[2].ok && r[2].scope === 'ip' && r[2].retryAfterSeconds >= 1);
  // The refused IP did not spend the site's third message.
  const other = await B.spendAssistantMessage(budget, '2.2.2.2', store);
  check('an IP over its own allowance did not spend the site\'s', other.ok);
  const spent = await B.spendAssistantMessage(budget, '3.3.3.3', store);
  check('the site-wide cap then holds for everyone', !spent.ok && spent.scope === 'site');

  const open = await B.spendAssistantMessage({ siteDaily: null, ipDaily: null }, '9.9.9.9', new RL.MemoryRateLimitStore());
  check('both caps off: always allowed', open.ok);
  check('the visitor message names no budget',
    !/site|ip|budget/i.test(B.BUDGET_EXHAUSTED_MESSAGE) && B.BUDGET_EXHAUSTED_MESSAGE.length > 20);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-assistant-budget-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];
for (const driver of DRIVERS) {
  const d = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(d, 'uploads'), { recursive: true });
  const env = { ...process.env };
  delete env.RATE_LIMIT_STORE;
  delete env.ASSISTANT_API_KEY;
  const run = spawnSync(process.execPath, [path.join(here, 'assistant-budget.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
    env: {
      ...env, ASSISTANT_BUDGET_CHILD: '1', NODE_ENV: 'test',
      ASTROBAAS_PLUGINS_ACTIVATE: 'ai-assistant',
      UPLOADS_DIR: path.join(d, 'uploads'), ...driver.env(d),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-1200)}`);
    continue;
  }
  const r = JSON.parse(line.slice('__RESULT__'.length));
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  t('the assistant is live in this fixture', r.a[0].status === 200 && r.a[0].body?.data?.reply === 'Hello from the stub');
  t('an empty message is a 400 and spends nothing', r.empty.status === 400 && r.empty.calls === 0);
  t('one IP gets its three answers', r.a.slice(0, 3).every((x) => x.status === 200));
  t('THE BUG: the fourth is refused with 429', r.a[3].status === 429);
  t('...in the plugin\'s own error envelope',
    r.a[3].body?.success === false && typeof r.a[3].body?.error?.message === 'string'
    && r.a[3].body?.error?.code === 'RATE_LIMITED');
  t('...with a Retry-After', Number(r.a[3].retryAfter) >= 1);
  t('...and WITHOUT calling the provider', r.a[3].calls === 3);
  t('other IPs share the site budget', r.b.status === 200 && r.c.status === 200);
  t('THE BUG: once the site-wide cap is spent, everyone is refused', r.d.status === 429);
  t('the provider was billed exactly five times', r.providerCalls === 5);
}
await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
