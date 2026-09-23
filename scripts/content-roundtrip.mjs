#!/usr/bin/env node
/**
 * Does a change made in the admin actually reach the reader?
 *
 *   node scripts/content-roundtrip.mjs [baseUrl]
 *
 * ## Why this exists beside the smoke suite
 *
 * `tests/smoke.mjs` asks the API what it stored. This asks the BROWSER what a
 * visitor sees. Those are different questions, and the gap between them is
 * where this codebase's most embarrassing bugs have lived: a term picker that
 * synced a hidden field nothing posted, term links rendered into a slot the
 * active theme overrides, alignment classes the sanitizer stripped on save.
 * Every one of those passed a server-side test.
 *
 * So each step here WRITES through the real API and then READS with a real
 * browser, and only counts as passing when the change is visible on the page.
 *
 * It is not part of the gate: it needs a running dev server and it changes
 * data. It is the pass to run before a release, and after any change to the
 * editor, the renderer or a theme.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4321';
const EMAIL = process.env.REVIEW_EMAIL || 'admin@local';
const PASSWORD = process.env.REVIEW_PASSWORD || 'review-admin-pass';
const STAMP = Date.now().toString(36);

let passed = 0;
const failures = [];
function ok(name) { passed += 1; console.log(`  ✓ ${name}`); }
function fail(name, detail) { failures.push({ name, detail }); console.log(`  ✗ ${name} — ${detail}`); }
function check(name, cond, detail = '') { cond ? ok(name) : fail(name, detail); }

/* ── an authenticated API client, sharing the browser's cookies ─────────── */
let cookieHeader = '';
let csrf = '';

async function api(method, route, body, isForm = false) {
  const headers = { Cookie: cookieHeader, 'X-CSRF-Token': csrf };
  if (!isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: isForm ? body : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text };
}

/** A real 2×2 PNG. Uploading a fixture proves the pipeline on actual bytes. */
const PNG_2x2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQ0A'
  + 'ABsAAwqZY1sAAAAASUVORK5CYII=', 'base64');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e.message)));

/** Read a public page as a visitor — a FRESH context with no admin session. */
async function asVisitor(route) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));
  const res = await p.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(700);
  const html = await p.content();
  const text = (await p.textContent('body').catch(() => '')) ?? '';
  await ctx.close();
  return { status: res?.status() ?? 0, html, text, errors: errs };
}

try {
  /* ── sign in ─────────────────────────────────────────────────────────── */
  console.log('\nSigning in');
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  const cookies = await context.cookies();
  cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  csrf = decodeURIComponent(cookies.find((c) => c.name === 'astrobaas_csrf')?.value ?? '');
  check('signed in and holding a CSRF token', !!csrf && cookieHeader.includes('astrobaas_session'), 'no session');

  /* ── 1. a POST, created ──────────────────────────────────────────────── */
  console.log('\nPosts');
  const postSlug = `roundtrip-${STAMP}`;
  const created = await api('POST', '/api/posts', {
    title: 'Γυαλιά ηλίου — δοκιμή',
    slug: postSlug,
    status: 'published',
    excerpt: 'Μια περίληψη για τη λίστα.',
    content: '<h2>Πρώτη ενότητα</h2><p>Το αρχικό κείμενο.</p>',
  });
  check('a post is created through the API', created.status === 201, `status=${created.status} ${created.text.slice(0, 120)}`);
  const postId = created.json?.data?.id;

  const article = await asVisitor(`/blog/${postSlug}`);
  check('...and the reader sees it', article.status === 200 && article.text.includes('Το αρχικό κείμενο'),
    `status=${article.status}`);
  check('...with its GREEK title intact', article.text.includes('Γυαλιά ηλίου — δοκιμή'), 'the title did not render');
  check('...and its heading survived the sanitizer', /<h2[^>]*>\s*Πρώτη ενότητα/.test(article.html), 'no h2');
  check('...with no page error', article.errors.length === 0, article.errors.join(' | '));

  const list = await asVisitor('/blog');
  check('...and it appears in the blog listing', list.text.includes('Γυαλιά ηλίου'), 'not in the list');

  /* ── 2. the same POST, edited ────────────────────────────────────────── */
  const edited = await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, {
    title: 'Γυαλιά ηλίου — αλλαγμένο',
    content: '<h2>Πρώτη ενότητα</h2><p>Το ΑΛΛΑΓΜΕΝΟ κείμενο.</p>',
  });
  check('the post is edited', edited.ok, `status=${edited.status}`);

  const after = await asVisitor(`/blog/${postSlug}`);
  check('...and the reader sees the NEW text', after.text.includes('Το ΑΛΛΑΓΜΕΝΟ κείμενο'), 'the change did not reach the page');
  check('...and NOT the old text', !after.text.includes('Το αρχικό κείμενο'), 'the old body is still being served');
  check('...and the new title', after.text.includes('αλλαγμένο'), 'the title did not change');

  /* ── 3. MEDIA, uploaded and used ─────────────────────────────────────── */
  console.log('\nMedia');
  const form = new FormData();
  form.append('file', new Blob([PNG_2x2], { type: 'image/png' }), `roundtrip-${STAMP}.png`);
  form.append('alt_text', 'Δοκιμαστική εικόνα');
  const upload = await api('POST', '/api/media/upload', form, true);
  check('an image uploads', upload.status === 201, `status=${upload.status} ${upload.text.slice(0, 140)}`);
  const mediaUrl = upload.json?.data?.url;
  check('...and the record carries a url', !!mediaUrl, JSON.stringify(upload.json?.data ?? {}).slice(0, 120));
  check('...and its stored dimensions were read from the file',
    upload.json?.data?.width === 2 && upload.json?.data?.height === 2,
    `w=${upload.json?.data?.width} h=${upload.json?.data?.height}`);
  check('...and the alt text was kept', upload.json?.data?.alt_text === 'Δοκιμαστική εικόνα',
    JSON.stringify(upload.json?.data?.alt_text));

  if (mediaUrl) {
    const served = await fetch(`${BASE}${mediaUrl}`);
    check('...the file is actually served', served.ok && Number(served.headers.get('content-length')) > 0,
      `status=${served.status}`);

    // The real question: does an image put in a post reach the reader WITH the
    // dimensions that prevent the page jumping?
    // TWO images, because the interesting rule is the difference between them.
    await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, {
      content: `<h2>Πρώτη ενότητα</h2><p>Το ΑΛΛΑΓΜΕΝΟ κείμενο.</p>`
        + `<img src="${mediaUrl}" alt="Πρώτη εικόνα">`
        + `<p>Ενδιάμεσο κείμενο.</p>`
        + `<img src="${mediaUrl}?second" alt="Δεύτερη εικόνα">`,
    });
    const withImage = await asVisitor(`/blog/${postSlug}`);
    const tags = withImage.html.match(/<img\b[^>]*>/gi) ?? [];
    const first = tags.find((t) => t.includes(mediaUrl) && !t.includes('?second')) ?? '';
    const second = tags.find((t) => t.includes('?second')) ?? '';
    check('an image in a post reaches the reader', first.length > 0, 'no img tag for the uploaded file');
    check('...carrying width and height, so the page does not jump',
      /width="2"/.test(first) && /height="2"/.test(first), first.slice(0, 180));
    // The FIRST image is deliberately NOT lazy: it is the likely Largest
    // Contentful Paint element, and lazy-loading it delays the very measurement
    // it looks like it improves.
    check('...and the FIRST image is eager, because it is the likely LCP element',
      !/loading="lazy"/.test(first) && /decoding="async"/.test(first), first.slice(0, 180));
    check('...while every image after it IS lazy',
      /loading="lazy"/.test(second), second.slice(0, 180) || 'no second image rendered');
  }

  /* ── 4. a PRODUCT, created and edited ────────────────────────────────── */
  console.log('\nProducts');
  const productSlug = `roundtrip-product-${STAMP}`;
  const product = await api('POST', '/api/products', {
    name: 'Σκελετός Τιτανίου',
    slug: productSlug,
    price_cents: 12900,
    stock: 4,
    // `active`, not `published`. A product and a post use different vocabularies
    // and the API is right to say so — this line was the test's mistake.
    status: 'active',
    description: '<p>Ελαφρύς σκελετός.</p>',
  });
  check('a product is created', product.status === 201, `status=${product.status} ${product.text.slice(0, 140)}`);
  const productId = product.json?.data?.id;

  // Searched, not paged. This install holds 443 products and the list is
  // capped — the first version asked for 200 and concluded the product was
  // missing when it was simply on another page. `search` is the parameter a
  // storefront would use anyway.
  const catalogue = await api('GET', `/api/products?search=${encodeURIComponent('Σκελετός Τιτανίου')}&limit=50`);
  const found = (catalogue.json?.data ?? []).find((p) => p.slug === productSlug);
  check('...and it is in the catalogue a storefront reads', !!found,
    `not returned by /api/products?search= — got ${(catalogue.json?.data ?? []).length} results`);
  check('...with its price intact', found?.price_cents === 12900, `price=${found?.price_cents}`);
  check('...and its Greek name intact', found?.name === 'Σκελετός Τιτανίου', found?.name);

  const editedProduct = await api('PUT', `/api/products/${encodeURIComponent(productId)}`, {
    price_cents: 9900,
    stock: 2,
  });
  check('the product is edited', editedProduct.ok, `status=${editedProduct.status}`);
  const single = await api('GET', `/api/products/${encodeURIComponent(productId)}`);
  check('...and the new price is what a storefront now reads', single.json?.data?.price_cents === 9900,
    `price=${single.json?.data?.price_cents}`);
  check('...and the new stock', single.json?.data?.stock === 2, `stock=${single.json?.data?.stock}`);

  /* ── 5. UNPUBLISHING actually hides it ───────────────────────────────── */
  console.log('\nVisibility');
  await api('PUT', `/api/posts/${encodeURIComponent(postId)}`, { status: 'draft' });
  const hidden = await asVisitor(`/blog/${postSlug}`);
  check('a post moved back to draft is NOT served to a visitor', hidden.status === 404,
    `status=${hidden.status} — an unpublished post is readable`);
  const listAgain = await asVisitor('/blog');
  check('...and is gone from the listing', !listAgain.text.includes('Γυαλιά ηλίου'), 'still listed');

  /* ── 6. clean up what this pass created ──────────────────────────────── */
  console.log('\nCleanup');
  const delPost = await api('DELETE', `/api/posts/${encodeURIComponent(postId)}`);
  check('the test post is removed', delPost.ok || delPost.status === 404, `status=${delPost.status}`);
  const delProduct = await api('DELETE', `/api/products/${encodeURIComponent(productId)}`);
  check('the test product is removed', delProduct.ok || delProduct.status === 404, `status=${delProduct.status}`);
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name} — ${f.detail}`);
  process.exit(1);
}
