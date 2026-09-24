import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Browser e2e for the core CMS flows. Drives real DOM interaction (forms,
 * buttons, navigation) on the production standalone build — the layer the HTTP
 * smoke test can't cover.
 */

/**
 * Session cookies from the first real login, reused by every later test.
 *
 * Playwright gives each test a fresh browser context, so without this the suite
 * logs in once per test — and the login throttle (10 attempts per 15 minutes
 * per IP + email, middleware.ts) starts returning 429 partway through. That is
 * the throttle working correctly: seventeen logins from one address with one
 * email is what credential stuffing looks like. Weakening it for the tests
 * would mean shipping a security control the tests do not actually exercise.
 *
 * So the suite behaves like a user instead: authenticate once, keep the
 * session. The login FORM is still tested for real — the cache is cold when
 * the "login works" test runs, because it is the first test that calls this.
 */
type SessionCookies = Awaited<ReturnType<BrowserContext['cookies']>>;
let cachedCookies: SessionCookies | null = null;

/**
 * `goto` that cannot be aborted by a navigation already in flight.
 *
 * Several tests submit a form — which navigates — and then immediately navigate
 * somewhere else to check the result. Chromium aborts one of the two, and the
 * error it raises is `net::ERR_ABORTED`, which reads like a server fault and is
 * not one. It passed locally for weeks and failed in CI, where the machine is
 * slower and the save navigation is still committing when the next goto starts.
 *
 * One helper rather than a wait at each of the eight call sites: this is a
 * property of the harness, and eight copies of a fix is how seven of them drift
 * back.
 */
async function go(page: Page, url: string) {
  // Settling is necessary but NOT sufficient: a save handler calls
  // location.reload(), and that reload can start in the window between
  // waitForLoadState resolving and goto being issued. Chromium then aborts one
  // of the two with "interrupted by another navigation" — a harness race that
  // reads like a server fault.
  //
  // So settle, then retry that ONE error. Anything else propagates: a blanket
  // retry would turn a genuine navigation failure into a slow, silent pass.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.waitForLoadState('domcontentloaded').catch(() => { /* nothing pending */ });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return;
    } catch (err) {
      const collision = /interrupted by another navigation|ERR_ABORTED/.test(String(err));
      if (!collision || attempt >= 2) throw err;
      await page.waitForTimeout(150);
    }
  }
}

/**
 * Must match `ADMIN_PASSWORD` in playwright.config.ts.
 *
 * It is not `admin` on purpose. This suite runs the BUILT server, where
 * `isProductionRuntime()` is true, so /login refuses the published default
 * outright (D2-7). Using a real password here keeps that refusal armed for the
 * test that asserts it.
 */
const ADMIN_PASSWORD = 'e2e-admin-not-the-default';

async function login(page: Page) {
  if (cachedCookies) {
    await page.context().addCookies(cachedCookies);
    await page.goto('/admin');
    // The session may have expired or the server restarted; fall through to a
    // real login rather than leaving the test on the sign-in page.
    if (!page.url().includes('/login')) return;
    cachedCookies = null;
  }
  await page.goto('/login');
  await page.fill('input[name="email"]', 'admin@local');
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/admin');
  cachedCookies = await page.context().cookies();
}

test('public home renders the site title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/AstroBaaS/);
  await expect(page.locator('header')).toContainText('AstroBaaS');
});

test('admin is protected and login works', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login/); // redirected
  await login(page);
  await expect(page).toHaveURL(/\/admin$/);
});

/*
 * The command palette.
 *
 * A real browser, because everything that can go wrong here is browser
 * behaviour: a keyboard shortcut that never fires, a modal that traps nothing,
 * a list that renders but cannot be driven with the arrow keys. A source-level
 * check would pass on all of it.
 */
test('the command palette opens on the keyboard and navigates', async ({ page }) => {
  await login(page);
  await page.goto('/admin');

  const palette = page.locator('#ab-palette');
  await expect(palette).toBeHidden();

  // The affordance carries the shortcut, so it is discoverable without docs.
  await expect(page.locator('#ab-palette-open')).toContainText('K');

  // ControlOrMeta is Playwright's platform-correct modifier.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette).toBeVisible();
  await expect(page.locator('#ab-palette-input')).toBeFocused();

  // An empty palette offers somewhere to go rather than a blank rectangle.
  await expect(page.locator('#ab-palette-list li').first()).toBeVisible();

  /*
   * `media`, not `order`.
   *
   * The palette hides the Shop group when commerce is off, exactly as the
   * sidebar does — and this install has it off. An earlier version of this test
   * navigated to Orders and passed only because the palette was over-listing
   * screens the sidebar deliberately hides.
   */
  await page.fill('#ab-palette-input', 'media');
  const first = page.locator('#ab-palette-list li').first();
  await expect(first).toContainText(/Media/i);
  await expect(first).toHaveAttribute('aria-selected', 'true');

  // The commerce parity itself, asserted rather than assumed.
  await page.fill('#ab-palette-input', 'orders');
  await expect(page.locator('#ab-palette-empty')).toBeVisible();

  /*
   * WHERE the match lands decides the order.
   *
   * "me" is the discriminating query, and picking it took a second look. The
   * first version used "or" — Orders ranks first, but Orders is ALSO first in
   * sidebar order, so the assertion passed identically with the ranking
   * function deleted. It proved nothing.
   *
   * With "me", sidebar order puts Custo-me-rs first and ranking puts Media
   * first, because Media starts with it. The two orders disagree, so only real
   * ranking satisfies this. That matters because the first row is what Enter
   * selects.
   */
  await page.fill('#ab-palette-input', 'me');
  await expect(page.locator('#ab-palette-list li').first()).toContainText(/Media/i);

  /*
   * The keyboard, actually pressed.
   *
   * These were named in this test's own preamble as the reason it runs in a
   * browser at all — "a list that renders but cannot be driven with the arrow
   * keys" — and then never exercised. A test that states its purpose and does
   * not carry it out is worse than a missing one.
   */
  await page.fill('#ab-palette-input', 'o');
  const rows = page.locator('#ab-palette-list li');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('ArrowUp');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  // Wrapping backwards from the top lands on the last row, not out of bounds.
  await page.keyboard.press('ArrowUp');
  await expect(rows.last()).toHaveAttribute('aria-selected', 'true');

  // Tab must not escape the dialog.
  await page.keyboard.press('Tab');
  await expect(page.locator('#ab-palette-input')).toBeFocused();

  // The scrim closes it. Clicked near a CORNER: the scrim covers the viewport
  // and its centre sits behind the panel, so a centre click — Playwright's
  // default — is intercepted by the dialog itself, which is not where anyone
  // clicks to dismiss one.
  await page.locator('#ab-palette-scrim').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#ab-palette')).toBeHidden();

  await page.keyboard.press('ControlOrMeta+k');
  await page.fill('#ab-palette-input', 'media');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/admin/media');
});

test('the palette closes on Escape and filters by folded text', async ({ page }) => {
  await login(page);
  await page.goto('/admin');

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#ab-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#ab-palette')).toBeHidden();

  // Case and accents are folded by the SAME function the catalogue uses, so a
  // Greek admin typing without accents still finds the screen.
  await page.keyboard.press('ControlOrMeta+k');
  await page.fill('#ab-palette-input', 'MEDIA');
  await expect(page.locator('#ab-palette-list li').first()).toBeVisible();

  // A query that matches nothing says so, naming what was typed.
  await page.fill('#ab-palette-input', 'zzzznotathing');
  await expect(page.locator('#ab-palette-empty')).toBeVisible();
  await expect(page.locator('#ab-palette-empty')).toContainText('zzzznotathing');
  await expect(page.locator('#ab-palette-list li')).toHaveCount(0);
});

test('the dashboard says what needs attention, or says nothing does', async ({ page }) => {
  await login(page);
  await page.goto('/admin');

  const feed = page.locator('section[aria-labelledby="ab-attention-heading"]');
  await expect(feed).toBeVisible();

  const cards = feed.locator('li');
  const count = await cards.count();

  /*
   * DETERMINISTIC, and it asserts the state this install is actually in.
   *
   * The first version branched on `count`, and in CI only one branch ever ran —
   * so half the test was dead, and the half that ran ended in
   * `toContainText(/\S/)`, which passes for any card containing a single
   * non-whitespace character, under a comment claiming it proved the severity
   * reaches a screen reader.
   *
   * The e2e install is a correctly configured shop: SITE_URL is set at build,
   * tax is off, the schema is current, nothing is scheduled in the past. So the
   * true assertion here is the ALL-CLEAR — which is the property most worth
   * defending anyway, because the failure mode of every dashboard like this is
   * manufacturing a task to fill the space.
   *
   * What this does NOT cover is the rendered card markup; that path is covered
   * by tests/attention.test.mjs, which drives all eight checks and every
   * severity. Saying so beats a branch that pretends to.
   */
  await expect(cards).toHaveCount(0);
  await expect(feed).toContainText(/Nothing needs your attention/i);
  expect(count).toBe(0);
});

test('create a post and see it published on the public blog', async ({ page }) => {
  await login(page);
  await page.goto('/admin/posts/new');

  const title = `E2E Post ${Date.now()}`;
  await page.fill('#post-title', title);
  // Slug auto-fills from the title; content lives in the rich text editor's textarea.
  await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="content"]') as HTMLTextAreaElement | null;
    if (ta) ta.value = '<p>Hello from a browser e2e test.</p>';
  });
  await page.selectOption('#post-status', 'published');

  // Assert on the create response directly (robust against redirect timing).
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/posts') && r.request().method() === 'POST',
    ),
    page.click('button[type="submit"][form="post-form"]'),
  ]);
  expect(resp.status()).toBe(201);

  // The post is visible on the public blog index.
  await go(page, '/blog');
  await expect(page.locator('body')).toContainText(title);
});

test('switch theme color in the customizer and see it applied (SSR)', async ({ page }) => {
  await login(page);
  await page.goto('/admin/themes');
  // Set a distinctive primary color and save.
  await page.fill('#primary-color-text', '#ff0055');
  /*
   * The save handler POSTs, flashes "saved", and only THEN reloads, on a 600ms
   * setTimeout (src/pages/admin/themes/index.astro:548). A sleep has to cover
   * the request plus that timer plus the render, and 1500ms was a guess at all
   * three.
   *
   * Waiting on the POST alone would be worse than the sleep, not better: it
   * returns 600ms BEFORE the reload starts, which is the collision, not the
   * cure. The reload is itself an observable navigation, so wait for that.
   * Registered before the click, because it is the only navigation this click
   * produces and registering after would be its own race.
   */
  const themeReloaded = page.waitForEvent('framenavigated', {
    predicate: (f) => f === page.mainFrame(),
    timeout: 10_000,
  });
  await page.click('#save-theme-changes');
  await themeReloaded;
  await go(page, '/');
  const root = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim(),
  );
  expect(root.toLowerCase()).toBe('#ff0055');
});

test('activate a plugin and see its filter affect rendered content', async ({ page }) => {
  await login(page);
  await page.goto('/admin/plugins');
  // Activate reading-time (button toggles based on current state).
  const row = page.locator('.plugin-toggle[data-plugin-id="reading-time"]');
  await expect(row).toBeVisible();
  if ((await row.getAttribute('data-active')) === '0') {
    await row.click();
    /*
     * Wait for the ACTIVATION, not for 800ms.
     *
     * This is the line that went red on CI with
     * `net::ERR_ABORTED at .../blog/welcome-to-astrobaas`, and the abort was
     * this test's own doing. The handler POSTs and then calls
     * `window.location.reload()` (src/pages/admin/plugins/index.astro:261). If
     * that reload commits while the goto below is in flight, Chromium cancels
     * one of the two — so the sleep was not slack, it was a starting pistol
     * pointed at the reload.
     *
     * Reproduced deterministically by delaying the toggle response: the test
     * fails at 760, 800 and 820ms and PASSES at 700 and at 2500. Non-monotonic,
     * which is the signature of a collision rather than a slow server — at
     * 2500ms the goto simply wins and the reload never runs.
     *
     * `data-active` is rendered server-side (index.astro:211) and the handler
     * only ever READS it, so '1' can appear only in the reloaded document.
     * Waiting for it is a barrier: when it passes, the reload is done and there
     * is nothing left to collide with.
     */
    await expect(row).toHaveAttribute('data-active', '1', { timeout: 10_000 });
  }
  // The seed published post now shows the reading-time badge.
  await go(page, '/blog/welcome-to-astrobaas');
  await expect(page.locator('body')).toContainText('min read');
});

test('showcase page renders CMS content + hydrates the 3D island', async ({ page }) => {
  await page.goto('/showcase');
  // CMS-driven content is server-rendered.
  await expect(page.locator('h1')).toContainText('in motion');
  await expect(page.locator('.parallax-layer').first()).toBeAttached();
  // The React Three Fiber island hydrates and Three.js mounts a <canvas>.
  // It's `client:visible`, so scroll it into view first.
  await page.locator('.canvas-wrap').scrollIntoViewIfNeeded();
  await expect(page.locator('.canvas-wrap canvas')).toBeVisible({ timeout: 10_000 });
  // Float-on-scroll: cards become visible as they enter the viewport.
  const card = page.locator('.float-card').first();
  if (await card.count()) {
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveClass(/in-view/, { timeout: 5_000 });
  }
});

test('production CSP is hash-based: script-src has hashes and NO unsafe-inline', async ({ request }) => {
  // The built server emits Astro's hash-based CSP as a response header. Guard the
  // hardening win against regression: scripts must be allow-listed by hash, never
  // by 'unsafe-inline'. (Astro inlines its own island bootstrap, so this only
  // works because every inline script is hashed.)
  const res = await request.get('/showcase');
  const csp = res.headers()['content-security-policy'] || '';
  expect(csp).toMatch(/script-src[^;]*'sha256-/); // scripts allow-listed by hash
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/); // never by unsafe-inline
  expect(csp).toMatch(/default-src 'self'/);
});

test('the CSP frames the embed providers, and nothing wider (C-44)', async ({ request }) => {
  // Asserted HERE rather than in the smoke suite because the page CSP is
  // Astro's and is emitted on BUILD only — a dev-server assertion would have
  // been checking a header that does not exist yet, which is the shape of a
  // test that cannot fail.
  //
  // Without these origins in frame-src, clicking a facade produces a blank box
  // and a console error, which is indistinguishable from "the embed is broken".
  const csp = (await request.get('/showcase')).headers()['content-security-policy'] || '';
  const frameSrc = /frame-src([^;]*)/.exec(csp)?.[1] ?? '';
  expect(frameSrc).toContain('https://www.youtube-nocookie.com');
  expect(frameSrc).toContain('https://player.vimeo.com');
  expect(frameSrc).toContain('https://www.openstreetmap.org');
  // An allow-list, not a hole: no wildcard, and youtube.com itself is absent —
  // the no-cookie domain is the one that does not set tracking cookies on load.
  expect(frameSrc).not.toMatch(/\*/);
  expect(frameSrc).not.toMatch(/https:\/\/www\.youtube\.com/);
});

test('plugin-contributed CSS applies under the hash-based CSP (served, not inlined)', async ({ page }) => {
  // Regression guard for a real bug: plugin markup is rendered per request, so
  // an inline <style> has no build-time CSP hash and the browser silently drops
  // it (tag in the DOM, `.sheet` null, CSS dead — no console error). Plugin CSS
  // is therefore served from /plugins.css. Assert the sheet is REALLY live, not
  // merely present, and that nothing got inlined.
  await login(page);
  await page.goto('/admin/plugins');
  const row = page.locator('.plugin-toggle[data-plugin-id="print-styles"]');
  await expect(row).toBeVisible();
  if ((await row.getAttribute('data-active')) === '0') {
    await row.click();
    // The same reload race as the reading-time test above, and the same
    // barrier. It has not gone red yet; it is the same code one screen over,
    // and fixing only the one that failed is how the next runner picks a
    // different line.
    await expect(row).toHaveAttribute('data-active', '1', { timeout: 10_000 });
  }

  await go(page, '/');
  const result = await page.evaluate(() => {
    const link = document.querySelector<HTMLLinkElement>('link[href="/plugins.css"]');
    // A stylesheet the browser actually accepted exposes live cssRules.
    const sheet = [...document.styleSheets].find((s) => (s.href || '').includes('/plugins.css'));
    let rules = 0;
    try {
      rules = sheet ? sheet.cssRules.length : 0;
    } catch {
      rules = -1; // opaque (would mean cross-origin, which it must not be)
    }
    return {
      linked: !!link,
      sheetLoaded: !!sheet,
      rules,
      // Astro inlines its OWN component styles (hashed at build time, so they're
      // allowed). What must never happen is plugin CSS being inlined — that's
      // the per-request, unhashable path the CSP silently drops.
      pluginCssInlined: [...document.head.querySelectorAll('style')].some((s) =>
        s.textContent?.includes('astrobaas:print-styles'),
      ),
    };
  });
  expect(result.linked).toBe(true); // plugin CSS is linked, not inlined
  expect(result.pluginCssInlined).toBe(false);
  expect(result.sheetLoaded).toBe(true); // the browser accepted it under CSP
  expect(result.rules).toBeGreaterThan(0); // and the rules are live
});

test('theme is served as an external stylesheet (CSP-safe), not an inline style', async ({ request }) => {
  const page = await request.get('/');
  const html = await page.text();
  // No inline style attribute on <html> anymore; the token stylesheet is linked.
  expect(html).not.toMatch(/<html[^>]*\sstyle=/);
  expect(html).toContain('/theme.css');
  const css = await request.get('/theme.css');
  expect(css.headers()['content-type']).toContain('text/css');
  expect(await css.text()).toContain('--primary-color');
});

test('admin commerce screens render and list catalogue data', async ({ page }) => {
  await login(page);

  // Seed a product through the API so the screens have something to show.
  // Slugs are unique, and this suite runs against a persistent dev database —
  // so the fixture must be unique per run or the second run 400s on the clash.
  const slug = `e2e-lamp-${Date.now()}`;
  const name = `E2E Lamp ${slug.slice(-6)}`;
  const created = await page.evaluate(async ({ slug, name }) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ name, slug, price_cents: 4200, stock: 7 }),
    });
    return { status: res.status, body: await res.json() };
  }, { slug, name });
  expect(created.status).toBe(201);

  await page.goto('/admin/products');
  await expect(page.locator('body')).toContainText(name);

  // Orders + customers are admin-gated screens; they must render for staff.
  await page.goto('/admin/orders');
  await expect(page).toHaveURL(/\/admin\/orders/);
  await page.goto('/admin/customers');
  await expect(page).toHaveURL(/\/admin\/customers/);
});

test('order limits are editable in admin settings and take effect on checkout', async ({ page }) => {
  // The limit is only a real control if the OPERATOR can reach it. Unit tests
  // cover the clamping and smoke covers enforcement; this proves the admin form
  // is actually wired to the setting the checkout reads.
  await login(page);
  await page.goto('/admin/settings');
  const field = page.locator('#order_max_qty_per_product');
  await expect(field).toBeVisible();
  await expect(field).toHaveValue('3'); // the shipped default

  await field.fill('6');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/settings/update') && r.request().method() === 'POST'),
    page.click('#commerce-form button[type="submit"]'),
  ]);

  // The public catalogue advertises the new cap, so a storefront picks it up.
  const meta = await page.evaluate(async () => (await (await fetch('/api/products')).json())?.meta);
  expect(meta.max_qty_per_product).toBe(6);

  // Restore the default so the suite is re-runnable against a persistent db.
  await go(page, '/admin/settings');
  await page.locator('#order_max_qty_per_product').fill('3');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/settings/update')),
    page.click('#commerce-form button[type="submit"]'),
  ]);
});

test('embeddable assistant: preflight + cookie-less CSRF exemption (built server)', async ({ request }) => {
  // The OPTIONS preflight only reaches OUR middleware on the built server —
  // `astro dev` lets Vite answer it first — so this assertion lives here.
  // Without a working preflight no browser ever sends the real cross-origin
  // POST, and the embeddable widget is dead on arrival.
  const ALLOWED = 'https://frontend.example.com';

  const preflight = await request.fetch('/api/assistant/chat', {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  expect(preflight.status()).toBe(204);
  expect(preflight.headers()['access-control-allow-origin']).toBe(ALLOWED);
  expect(preflight.headers()['access-control-allow-methods']).toContain('POST');

  // The widget script itself is servable and self-contained.
  const widget = await request.get('/assistant-widget.js');
  expect(widget.status()).toBe(200);
  const js = await widget.text();
  // credentials:'omit' is what makes the CSRF exemption sound — pin it.
  expect(js).toContain("credentials: 'omit'");
  expect(js).not.toMatch(/sk-[A-Za-z0-9]/);
});

test('editing a product in the admin does not destroy its variants or images', async ({ page }) => {
  // Regression guard for a real data-loss bug: the product row embedded a
  // 13-field subset in `data-p` while the modal read ~30 fields, so opening a
  // product and clicking Save submitted `variants: []`, `images: []`,
  // `attributes: []` and silently wiped them. Proved by PUTting the modal's
  // exact payload and watching 2 variants become 0.
  //
  // This is the test that was missing: the modal and the image manager were
  // each verified in isolation, but the product was never ROUND-TRIPPED.
  await login(page);

  const slug = `e2e-variants-${Date.now()}`;
  const created = await page.evaluate(async (slug) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({
        name: `E2E Frame ${slug.slice(-6)}`, slug, price_cents: 9900,
        tags: ['sun', 'polarised'],
        attributes: [{ name: 'Colour', values: ['Black', 'Tortoise'] }],
        images: [{ src: '/media/e2e-a.jpg' }, { src: '/media/e2e-b.jpg' }],
        variants: [
          { options: { Colour: 'Black' }, stock: 4 },
          { options: { Colour: 'Tortoise' }, stock: 2, price_cents: 11900 },
        ],
      }),
    });
    return res.json();
  }, slug);
  expect(created.success).toBe(true);
  expect(created.data.variants).toHaveLength(2);
  const variantIds = created.data.variants.map((v: any) => v.id).sort();

  // Open the product in the admin and save it WITHOUT changing anything.
  // The search runs on the server now (the list is paginated), so submit it:
  // that is also what finds a product that is not on the first page.
  await page.goto('/admin/products');
  await page.fill('#filter', slug.slice(-6));
  await Promise.all([page.waitForURL(/\?q=/), page.press('#filter', 'Enter')]);
  const editBtn = page.locator(`.edit[data-id="${created.data.id}"]`);
  await expect(editBtn).toBeVisible();
  await editBtn.click();
  // The modal loads asynchronously now (it fetches the full record).
  await expect(page.locator('#variant-rows tr')).toHaveCount(2);

  /*
   * Same family as the plugin race, different symptom.
   *
   * The product form calls `location.reload()` the instant the PUT resolves
   * (src/pages/admin/products.astro:1361) — no timer. `page.evaluate` below
   * runs inside the page's JS context, and a reload committing mid-evaluate
   * destroys that context: the failure reads "Execution context was destroyed",
   * which points at the evaluate and not at the save that caused it.
   *
   * So wait for the reload rather than sleeping past it. Registered before the
   * click, for the same reason as the theme test.
   */
  const savedAndReloaded = page.waitForEvent('framenavigated', {
    predicate: (f) => f === page.mainFrame(),
    timeout: 10_000,
  });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/products/') && r.request().method() === 'PUT'),
    page.click('#product-form button[type="submit"]'),
  ]);
  await savedAndReloaded;

  const after = await page.evaluate(async (slug) => {
    const res = await fetch(`/api/products/${slug}`);
    return (await res.json()).data;
  }, slug);

  // Nothing may be lost by a no-op save.
  expect(after.variants).toHaveLength(2);
  expect(after.variants.map((v: any) => v.id).sort()).toEqual(variantIds); // ids stable = order history intact
  expect(after.type).toBe('variable');
  expect(after.images).toHaveLength(2);
  expect(after.attributes).toHaveLength(1);
  expect(after.tags).toHaveLength(2);
  // Variant stock survives too.
  expect(after.variants.find((v: any) => v.options.Colour === 'Black').stock).toBe(4);
});

/*
 * Pagination on the admin lists (src/lib/admin-paging.ts). Products used to
 * render the whole catalogue and filter it in the browser, which cannot find
 * anything that was not sent; posts and pages paged ten at a time with the
 * controls hidden below eleven. Each run seeds records under a unique marker
 * and searches for it, so earlier tests' data does not change the counts.
 */
async function seed(page: Page, url: string, bodies: object[]) {
  return page.evaluate(async ({ url, bodies }) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
    for (const body of bodies) {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${url} ${res.status} ${await res.text()}`);
    }
  }, { url, bodies });
}

test('the products list pages, and its search reaches every page', async ({ page }) => {
  await login(page);
  await page.goto('/admin/products');
  const mark = `pg${Date.now().toString(36)}`;
  await seed(page, '/api/products', Array.from({ length: 30 }, (_, i) => ({
    name: `Paged ${mark} ${String(i + 1).padStart(2, '0')}`, slug: `${mark}-${i + 1}`, price_cents: 1000 + i,
  })));

  await page.goto(`/admin/products?q=${mark}`);
  await expect(page.locator('.product-row')).toHaveCount(25);
  await expect(page.locator('[data-pagination-summary]')).toHaveText(/1–25 of 30/);

  await page.click('.admin-pagination a[rel="next"]');
  await expect(page).toHaveURL(new RegExp(`q=${mark}.*page=2|page=2.*q=${mark}`));
  await expect(page.locator('.product-row')).toHaveCount(5);
  await expect(page.locator('[data-pagination-summary]')).toHaveText(/26–30 of 30/);

  // A product on the LAST page, found from the first: the old in-browser
  // filter could only hide rows it had been sent, so this was impossible.
  const lastName = `Paged ${mark} 30`;
  await page.goto('/admin/products');
  await page.fill('#filter', lastName);
  await Promise.all([page.waitForURL(/\?q=/), page.press('#filter', 'Enter')]);
  await expect(page.locator('.product-row')).toHaveCount(1);
  await expect(page.locator('.product-row')).toContainText(lastName);

  await page.goto(`/admin/products?q=${mark}&per=50`);
  await expect(page.locator('.product-row')).toHaveCount(30);
  await expect(page.locator('.admin-pagination nav')).toHaveCount(0);

  await page.goto(`/admin/products?q=nothing-${mark}`);
  await expect(page.locator('#rows')).toContainText('No products match');

  // Newest first: the product just created is at the top of page 1, with no
  // search — paged oldest-first, it reloaded onto the last page, out of sight.
  await page.goto('/admin/products');
  await expect(page.locator('.product-row').first()).toContainText(`Paged ${mark} 30`);
});

test('posts and pages page too, and the controls show from page 1', async ({ page }) => {
  await login(page);
  await page.goto('/admin/posts');
  const mark = `pp${Date.now().toString(36)}`;
  await seed(page, '/api/posts', [
    ...Array.from({ length: 27 }, (_, i) => ({ title: `Post ${mark} ${i + 1}`, status: 'draft', kind: 'post' })),
    ...Array.from({ length: 12 }, (_, i) => ({ title: `Page ${mark} ${i + 1}`, status: 'draft', kind: 'page' })),
  ]);

  await page.goto(`/admin/posts?q=${mark}&kind=post`);
  await expect(page.locator('[data-pagination-summary]')).toHaveText(/1–25 of 27/);
  await page.click('.admin-pagination a[rel="next"]');
  await expect(page.locator('[data-pagination-summary]')).toHaveText(/26–27 of 27/);
  // The filters survive paging: still only posts, still only this run's.
  expect(page.url()).toContain('kind=post');
  expect(page.url()).toContain(`q=${mark}`);

  // Twelve pages fit on one page of 25 — the size choice is still offered,
  // where the old controls disappeared entirely below eleven.
  await page.goto(`/admin/posts?q=${mark}&kind=page`);
  await expect(page.locator('[data-pagination-summary]')).toHaveText(/1–12 of 12/);
  await expect(page.locator('.admin-pagination nav')).toHaveCount(0);
  await page.goto(`/admin/posts?q=${mark}`);
  await expect(page.locator('[data-pagination-summary]')).toHaveText(/1–25 of 39/);
  await page.click('.admin-pagination >> text=50');
  await expect(page.locator('[data-pagination-summary]')).toHaveText(/1–39 of 39/);
});

test('public catalogue is readable without auth; orders are not', async ({ page, request }) => {
  // Commerce is opt-in since the master switch landed: on an install that has
  // not chosen to be a shop the whole surface answers 404, deliberately. This
  // test is about a SHOP, so it opens one first — otherwise it measures the
  // switch and reports it as a broken catalogue.
  await login(page);
  const openShop = () => page.evaluate(async () => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
    await fetch('/api/settings/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ commerce_enabled: true }),
    });
  });
  await openShop();

  const list = await request.get('/api/products');
  expect(list.status()).toBe(200);

  // Orders carry PII and must never be anonymously readable.
  const orders = await request.get('/api/orders');
  expect([401, 403]).toContain(orders.status());

  // And with the shop closed again, the catalogue is not merely empty — it is
  // GONE, which is the promise the switch makes. Restored immediately after:
  // this suite runs serially against one shared server (workers: 1), so a
  // setting left flipped is a landmine for every test that follows.
  const setCommerce = (on: boolean) => page.evaluate(async (enabled) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
    await fetch('/api/settings/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ commerce_enabled: enabled }),
    });
  }, on);

  await setCommerce(false);
  const closed = await request.get('/api/products');
  await setCommerce(true);
  expect(closed.status()).toBe(404);
});

test('the section palette inserts a hero that survives a real save and renders styled', async ({ page }) => {
  // The palette is the one part of Phase G that only exists in a browser: it
  // writes into a contenteditable via execCommand and syncs a hidden textarea.
  // An HTTP test cannot tell whether that wiring works — it can only see the
  // markup the browser eventually posted, which is exactly what this asserts.
  await login(page);
  await page.goto('/admin/posts/new');

  const title = `E2E Sections ${Date.now()}`;
  await page.fill('#post-title', title);
  await page.selectOption('#kind', 'page');
  await page.selectOption('#post-status', 'published');

  // Put the caret in the editor, then click the Hero button in the palette.
  await page.click('#post-content');
  await page.click('.ab-insert-section[data-section="hero"]');
  await page.click('.ab-insert-section[data-section="columns"]');

  // The palette must have synced the hidden textarea — that field, not the
  // contenteditable, is what the form actually submits.
  const staged = await page.evaluate(() =>
    (document.querySelector('#post-content')?.closest('.rich-text-editor')
      ?.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? '');
  expect(staged).toContain('ab-hero');
  expect(staged).toContain('ab-columns');

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/posts') && r.request().method() === 'POST'),
    page.click('button[type="submit"][form="post-form"]'),
  ]);
  const created = (await resp.json())?.data;
  expect(created?.kind).toBe('page');

  // THE assertion: the classes survived the sanitizer on the way into storage.
  // If the palette ever emits something the allow-list omits, the author sees
  // it work in the editor and loses it here, silently.
  expect(created?.content).toContain('ab-hero');
  expect(created?.content).toContain('ab-cols-2');

  // And the saved page renders at its root URL with the section styles applied.
  //
  // Wait for the FORM's own post-save navigation to finish first. Without this
  // the goto below races it and Chromium aborts one of the two —
  // `net::ERR_ABORTED`, which reads like a server error and is not one. It
  // passed locally for weeks and failed in CI, where the machine is slower and
  // the save navigation is still in flight when the next goto starts.
  await go(page, `/${created.slug}`);
  const hero = page.locator('.ab-hero').first();
  await expect(hero).toBeVisible();
  // sections.css is token-driven; a real computed padding proves the stylesheet
  // reached the page rather than the class merely being present in the HTML.
  const padded = await hero.evaluate((el) => parseFloat(getComputedStyle(el).paddingTop) > 0);
  expect(padded).toBe(true);

  // Columns collapse to a single column on a phone.
  await page.setViewportSize({ width: 375, height: 812 });
  const cols = await page.locator('.ab-columns').first()
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(1);
});

test('a page set as the home page is served at / and falls back when it goes away', async ({ page }) => {
  await login(page);

  // Create a page to promote.
  await page.goto('/admin/posts/new');
  const marker = `Home E2E ${Date.now()}`;
  await page.fill('#post-title', marker);
  await page.selectOption('#kind', 'page');
  await page.selectOption('#post-status', 'published');
  await page.evaluate((text) => {
    const ta = document.querySelector('textarea[name="content"]') as HTMLTextAreaElement | null;
    if (ta) ta.value = `<div class="ab-hero"><h2>${text}</h2></div>`;
  }, marker);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/posts') && r.request().method() === 'POST'),
    page.click('button[type="submit"][form="post-form"]'),
  ]);
  const slug = (await resp.json())?.data?.slug;
  expect(slug).toBeTruthy();

  // Designate it from the real settings screen, not the API.
  await go(page, '/admin/settings');
  await page.selectOption('#home_page_slug', slug);
  /*
   * Wait for the WRITE, not for 500ms.
   *
   * `#general-form` does NOT reload — that 600ms timer belongs to `groups-form`
   * and `shop-toggle-form` (settings/index.astro:1735, 1751), and assuming it
   * applied here would have been a fix for a race this line does not have. Its
   * handler just POSTs /api/settings/update (settings/index.astro:1545,1551).
   * So the risk is the opposite one: navigate before the POST lands and the
   * setting is never written, which surfaces as the home-page assertion below
   * failing for a reason that has nothing to do with home pages.
   */
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/settings/update') && r.request().method() === 'POST',
    ),
    page.click('#general-form button[type="submit"]'),
  ]);

  await go(page, '/');
  await expect(page.locator('.ab-hero')).toContainText(marker);

  // Clearing it restores the stock page — the fallback that keeps a live site's
  // front door up when the setting goes stale.
  await go(page, '/admin/settings');
  await page.selectOption('#home_page_slug', '');
  // Same write, same barrier as above.
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/settings/update') && r.request().method() === 'POST',
    ),
    page.click('#general-form button[type="submit"]'),
  ]);
  await go(page, '/');
  await expect(page.locator('.ab-hero')).toHaveCount(0);
});

test('patterns insert a whole layout and the section toolbar reorders it', async ({ page }) => {
  // Patterns and the toolbar are pure browser behaviour: contenteditable
  // manipulation plus a textarea sync. An HTTP test can only see what was
  // eventually posted, which is why the intermediate DOM state is asserted here.
  await login(page);
  await page.goto('/admin/posts/new');
  await page.fill('#post-title', `E2E Pattern ${Date.now()}`);
  await page.selectOption('#kind', 'page');
  await page.selectOption('#post-status', 'published');

  await page.click('#post-content');
  await page.click('.ab-insert-pattern[data-pattern="landing"]');

  // The landing pattern is hero + columns + cta, in that order.
  const order = () => page.$$eval('#post-content > div', (els) =>
    els.map((el) => [...el.classList].find((c) => c.startsWith('ab-')) ?? ''));
  expect(await order()).toEqual(['ab-hero', 'ab-columns', 'ab-cta']);

  // The toolbar only appears when the caret is inside a section.
  await page.click('#post-content .ab-cta');
  await expect(page.locator('.ab-section-modifiers')).toBeVisible();
  await expect(page.locator('.ab-current-section')).toHaveText('Call to action');

  // Move it up one. The buttons use mousedown, because a click would blur the
  // editor and destroy the selection before the handler ran.
  await page.locator('.ab-section-op[data-op="up"]').dispatchEvent('mousedown');
  expect(await order()).toEqual(['ab-hero', 'ab-cta', 'ab-columns']);

  // Duplicate, then delete the copy — back where we started.
  await page.locator('.ab-section-op[data-op="duplicate"]').dispatchEvent('mousedown');
  expect(await order()).toEqual(['ab-hero', 'ab-cta', 'ab-cta', 'ab-columns']);
  await page.locator('.ab-section-op[data-op="delete"]').dispatchEvent('mousedown');
  expect(await order()).toEqual(['ab-hero', 'ab-cta', 'ab-columns']);

  // Every operation must have synced the hidden textarea — that is what saves.
  const staged = await page.evaluate(() =>
    (document.querySelector('#post-content')?.closest('.rich-text-editor')
      ?.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? '');
  expect(staged.indexOf('ab-cta')).toBeLessThan(staged.indexOf('ab-columns'));

  // And the reordered layout survives the sanitizer into storage.
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/posts') && r.request().method() === 'POST'),
    page.click('button[type="submit"][form="post-form"]'),
  ]);
  const content = (await resp.json())?.data?.content ?? '';
  expect(content.indexOf('ab-cta')).toBeLessThan(content.indexOf('ab-columns'));
  expect(content).toContain('ab-hero');
});

test('a manager adds and edits a product through the admin UI', async ({ page }) => {
  // The product form is a tabbed modal driven by JavaScript, so an HTTP test
  // cannot tell whether a shop manager can actually use it. This drives the
  // real screen as the role that will use it every day.
  //
  // The CREATE half goes through the form. The EDIT half starts from a product
  // created over the API: the assertion that matters there is that re-opening
  // the editor repopulates every field and that saving one field does not blank
  // the others — and pinning the id up front keeps that assertion independent
  // of how many products earlier tests happen to have left behind.
  await login(page);

  await page.evaluate(async () => {
    await fetch('/api/users/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': document.cookie.match(/astrobaas_csrf=([^;]+)/)?.[1] ?? '',
      },
      body: JSON.stringify({
        name: 'Shop Manager', email: 'mgr-e2e@example.com',
        password: 'manager-pass-123', role: 'manager',
      }),
    });
  });

  // Sign in as the manager for real. The admin session has to go first, or
  // /login just redirects to /admin and there is no form to fill.
  await page.context().clearCookies();
  await page.goto('/login');
  await page.fill('input[name="email"]', 'mgr-e2e@example.com');
  await page.fill('input[name="password"]', 'manager-pass-123');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/admin');

  /* ---- CREATE, through the form ---- */
  await page.goto('/admin/products');
  await expect(page.locator('#new-product')).toBeVisible();
  await page.click('#new-product');
  await expect(page.locator('#product-dialog')).toBeVisible();

  // The form is tabbed (general / inventory / shipping / images / variants /
  // advanced), so filling a product means moving between tabs — asserted here
  // because it is the actual daily workflow, not an implementation detail.
  const name = `E2E Frame ${Date.now()}`;
  await page.fill('[name="name"]', name);
  await page.fill('[name="price"]', '129.90');
  await page.fill('[name="sku"]', `SKU-${Date.now().toString(36)}`);
  await page.fill('[name="short_description"]', 'A test frame.');

  await page.click('[data-tab="inventory"]');
  await expect(page.locator('[name="stock"]')).toBeVisible();
  await page.fill('[name="stock"]', '7');
  // The optical fields live here too — the vertical these shops actually need.
  await expect(page.locator('[name="requires_prescription"]')).toBeAttached();

  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/products') && r.request().method() === 'POST'),
    page.click('#product-form button[type="submit"]'),
  ]);
  expect(created.status()).toBeLessThan(400);

  // It reaches the list the manager will look at.
  await go(page, '/admin/products');
  await expect(page.locator('body')).toContainText(name);

  /* ---- EDIT, through the form, on a product with a known id ---- */
  const seed = await page.evaluate(async () => {
    const csrf = document.cookie.match(/astrobaas_csrf=([^;]+)/)?.[1] ?? '';
    const n = `E2E Edit ${Date.now()}`;
    const r = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({
        name: n, slug: `e2e-edit-${Date.now().toString(36)}`,
        price_cents: 12990, stock: 7, sku: `EDIT-${Date.now().toString(36)}`,
        short_description: 'A test frame.',
      }),
    });
    return (await r.json())?.data;
  });
  expect(seed?.id).toBeTruthy();
  expect(seed.price_cents).toBe(12990);

  await page.goto('/admin/products');
  await page.click(`.edit[data-id="${seed.id}"]`);
  await expect(page.locator('#product-dialog')).toBeVisible();

  // Stored values must come BACK into the form. A form that repopulates
  // partially silently blanks whatever it forgot on the next save — the failure
  // this screen is most prone to.
  await expect(page.locator('[name="name"]')).toHaveValue(seed.name);
  await expect(page.locator('[name="price"]')).toHaveValue('129.90');
  await expect(page.locator('[name="short_description"]')).toHaveValue('A test frame.');
  await page.click('[data-tab="inventory"]');
  await expect(page.locator('[name="stock"]')).toHaveValue('7');

  // Change one field; everything else must survive.
  await page.fill('[name="stock"]', '3');
  const [updated] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/products') && r.request().method() === 'PUT'),
    page.click('#product-form button[type="submit"]'),
  ]);
  expect(updated.status()).toBeLessThan(400);

  await go(page, '/admin/products');
  const after = await page.evaluate(async (id) =>
    (await (await fetch(`/api/products/${id}`)).json())?.data, seed.id);
  expect(after?.stock).toBe(3);
  // Money stays integer minor units, and the untouched fields are intact.
  expect(after?.price_cents).toBe(12990);
  expect(after?.name).toBe(seed.name);
  expect(after?.sku).toBe(seed.sku);
  expect(after?.short_description).toBe('A test frame.');
  expect(after?.status).toBe(seed.status);
});

test('the product dialog centres and row thumbnails are not squeezed', async ({ page }) => {
  // Two defects found by looking at the admin on a wide screen, both invisible
  // to every assertion that only checks content:
  //
  //  * the row thumbnail computed to 24px wide (13px on a real catalogue).
  //    NOT a flex problem, though it looks like one: the parent is a
  //    `display: table-cell`, and the cell was `w-14` with `px-4` — 56px minus
  //    32px of padding leaves 24px of content box, so a 40px image cannot fit.
  //    Arithmetic, not flexbox. Diagnosed by reading the computed styles in the
  //    browser rather than by reasoning about the class list, which is how the
  //    first attempted fix (`shrink-0`, on a non-flex parent) did nothing at
  //    all while looking plausible.
  //  * the dialog rendered flush against the top-left corner. A native <dialog>
  //    centres through `margin: auto` in the UA stylesheet, and Tailwind's
  //    preflight resets margin to 0 on every element.
  //
  // Measured, not screenshotted: a number that must hold is a regression test,
  // a picture is a thing someone has to look at again next time.
  await login(page);

  const suffix = Date.now().toString(36);
  await page.evaluate(async (sfx) => {
    const csrf = document.cookie.match(/astrobaas_csrf=([^;]+)/)?.[1] ?? '';
    await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({
        name: `E2E Thumb ${sfx}`, slug: `e2e-thumb-${sfx}`, price_cents: 1000,
        images: [{ src: '/favicon.svg', alt: '' }],
      }),
    });
  }, suffix);

  await go(page, '/admin/products');

  // --- thumbnail ---
  const thumb = page.locator(`tr:has-text("E2E Thumb ${suffix}") img`).first();
  await expect(thumb).toBeVisible();
  const box = await thumb.boundingBox();
  // h-10 w-10 is 40x40. Anything materially under that means the flex row won.
  expect(box!.width).toBeGreaterThanOrEqual(36);
  expect(box!.height).toBeGreaterThanOrEqual(36);

  // --- the Delete button must be reachable without hunting for it ---
  //
  // The table scrolls horizontally on a wide catalogue and the actions column
  // sat past the fold. On macOS the scrollbar is hidden until you scroll, so it
  // read as "Delet" clipped at the edge — a destructive action you have to go
  // looking for. The column is now `sticky right-0`, so this asserts it lands
  // inside the scroll container rather than beyond it.
  const del = page.locator('#rows tr').first().locator('button.del');
  await expect(del).toBeVisible();
  const reach = await page.evaluate(() => {
    const btn = document.querySelector('#rows tr button.del') as HTMLElement | null;
    const scroller = btn?.closest('.overflow-x-auto') as HTMLElement | null;
    if (!btn || !scroller) return null;
    const b = btn.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return { fullyInside: b.right <= s.right + 1 && b.left >= s.left - 1, overhang: b.right - s.right };
  });
  expect(reach).not.toBeNull();
  expect(reach!.fullyInside).toBe(true);

  // --- dialog centring ---
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.click('#new-product');
  const dialog = page.locator('#product-dialog');
  await expect(dialog).toBeVisible();

  const geom = await page.evaluate(() => {
    const d = document.getElementById('product-dialog')!;
    const r = d.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, vw: window.innerWidth };
  });
  // Centred means the gaps either side match. Pinned top-left means left ~0 and
  // the whole remainder on the right, which is what this caught.
  const gapLeft = geom.left;
  const gapRight = geom.vw - geom.right;
  expect(gapLeft).toBeGreaterThan(50);
  expect(Math.abs(gapLeft - gapRight)).toBeLessThan(4);
});

test('a manager files a product into categories from the product form', async ({ page }) => {
  // The form loaded the category list and rendered it nowhere — there was no
  // control for `categories` at all, only a count in the page subtitle. The API
  // accepted them the whole time, so this was invisible to every HTTP test: a
  // manager simply could not put a new product into a category, and the
  // storefront builds its entire menu from that tree, so the product was
  // reachable at /shop and in no menu category at all.
  await login(page);

  const suffix = Date.now().toString(36);
  const parent = `e2e-cat-parent-${suffix}`;
  const child = `e2e-cat-child-${suffix}`;
  const other = `e2e-cat-other-${suffix}`;

  // A parent with a child, so the hierarchy is exercised rather than a flat list.
  await page.evaluate(async ([parent, child, other]) => {
    const csrf = document.cookie.match(/astrobaas_csrf=([^;]+)/)?.[1] ?? '';
    const mk = (slug: string, name: string, parent_slug?: string) =>
      fetch('/api/product-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ name, slug, ...(parent_slug ? { parent_slug } : {}) }),
      });
    await mk(parent, 'E2E Parent');
    await mk(child, 'E2E Child', parent);
    await mk(other, 'E2E Other');
  }, [parent, child, other]);

  // Settles any in-flight reload first, for the same reason read() does below.
  const countOf = async (slug: string) => {
    await page.waitForLoadState('domcontentloaded').catch(() => { /* idle */ });
    return page.evaluate(async (s: string) => {
      const j = await (await fetch('/api/product-categories')).json();
      return (j?.data || []).find((c: any) => c.slug === s)?.product_count ?? null;
    }, slug);
  };

  expect(await countOf(child)).toBe(0);

  /* ---- CREATE with categories chosen in the form ---- */
  await page.goto('/admin/products');
  await page.click('#new-product');
  await expect(page.locator('#product-dialog')).toBeVisible();

  // The child must be reachable: a category nested under a parent that the tree
  // walk failed to visit would silently vanish from this list.
  const childBox = page.locator(`#cat-list input[value="${child}"]`);
  await expect(childBox).toBeVisible();

  const name = `E2E Filed ${suffix}`;
  await page.fill('[name="name"]', name);
  // A COMMA decimal, as staff here actually type. The old number input reported
  // "" for this, so the regular price silently became 0 (or the browser refused
  // a field that plainly had a value in it).
  await page.fill('[name="price"]', '159,00');
  await childBox.check();

  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/products') && r.request().method() === 'POST'),
    page.click('#product-form button[type="submit"]'),
  ]);
  expect(created.status()).toBeLessThan(400);

  // The id is looked up AFTER the save, not read from the response body: the
  // form calls location.reload() on success, and Chromium discards the body of
  // a response that has been navigated away from.
  await go(page, '/admin/products');
  const madeId = await page.evaluate(async (n) => {
    const j = await (await fetch('/api/products?limit=200')).json();
    return (j?.data || []).find((p: any) => p.name === n)?.id ?? null;
  }, name);
  expect(madeId).toBeTruthy();

  // Every save in this form ends in location.reload(), so a read must settle
  // that navigation first — evaluating into a context the reload is tearing
  // down throws "Execution context was destroyed". go() is the suite's existing
  // answer to exactly this race.
  const read = async (id: string) => {
    await go(page, '/admin/products');
    return page.evaluate(async (i: string) =>
      (await (await fetch(`/api/products/${i}`)).json())?.data, id);
  };

  let prod = await read(madeId);
  expect(prod.categories).toEqual([child]);
  expect(prod.price_cents).toBe(15900);   // "159,00" -> 15900, not 0
  expect(await countOf(child)).toBe(1);

  /* ---- EDIT without touching categories: they must survive ---- */
  await go(page, '/admin/products');
  await page.click(`.edit[data-id="${madeId}"]`);
  await expect(page.locator('#product-dialog')).toBeVisible();
  // Pre-selected from the stored value — an edit form that forgets this blanks
  // the field on the next save.
  await expect(page.locator(`#cat-list input[value="${child}"]`)).toBeChecked();
  await expect(page.locator(`#cat-list input[value="${other}"]`)).not.toBeChecked();

  await page.fill('[name="short_description"]', 'Untouched categories.');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/products') && r.request().method() === 'PUT'),
    page.click('#product-form button[type="submit"]'),
  ]);
  prod = await read(madeId);
  expect(prod.categories).toEqual([child]);
  expect(prod.short_description).toBe('Untouched categories.');

  /* ---- EDIT to change categories ---- */
  await go(page, '/admin/products');
  await page.click(`.edit[data-id="${madeId}"]`);
  await expect(page.locator('#product-dialog')).toBeVisible();
  await page.locator(`#cat-list input[value="${child}"]`).uncheck();
  await page.locator(`#cat-list input[value="${parent}"]`).check();
  await page.locator(`#cat-list input[value="${other}"]`).check();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/products') && r.request().method() === 'PUT'),
    page.click('#product-form button[type="submit"]'),
  ]);

  prod = await read(madeId);
  expect(prod.categories.slice().sort()).toEqual([other, parent].sort());
  // The counts the storefront menu is built from move with it.
  expect(await countOf(child)).toBe(0);
  expect(await countOf(parent)).toBe(1);
  expect(await countOf(other)).toBe(1);
});

test('a form built in the admin works for a stranger, and its entries stay private', async ({ page, request, context }) => {
  // The whole point of the form builder: an operator defines a type, and a
  // visitor with no account fills the form in and it arrives. The HTTP smoke
  // test covers the endpoint's rules; this covers the part only a browser can
  // — the generated page, its client script, the CSRF cookie a real visitor
  // carries, and the anti-spam widget attached to the form.
  await login(page);
  await page.evaluate(async () => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
    await fetch('/api/content-types', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify([
        {
          name: 'e2e-enquiry', label: 'Enquiry', labelPlural: 'Enquiries',
          visibility: 'staff', writable: 'public',
          fields: [
            { name: 'name', rule: { type: 'string', min: 1, max: 100 } },
            { name: 'message', rule: { type: 'string', min: 1, max: 400 } },
          ],
        },
        {
          // Exists, and never asked for submissions. It must have no form page
          // — otherwise the builder publishes a write endpoint for every type
          // an operator ever created.
          name: 'e2e-internal', label: 'Internal note',
          fields: [{ name: 'title', rule: { type: 'string', min: 1, max: 80 } }],
        },
      ]),
    });
  });

  // A visitor with no session at all.
  const visitor = await context.browser()!.newContext();
  const guest = await visitor.newPage();
  await guest.goto('/forms/e2e-enquiry');

  // The fields came from the definition, and so did their labels.
  await expect(guest.locator('#f-e2e-enquiry-name')).toBeVisible();
  // 400 chars is over the textarea threshold, so `message` is a textarea.
  await expect(guest.locator('textarea#f-e2e-enquiry-message')).toBeVisible();
  // The honeypot exists and is invisible to a person.
  await expect(guest.locator('input[name="hp_url"]')).toBeHidden();

  await guest.fill('#f-e2e-enquiry-name', 'A stranger');
  await guest.fill('#f-e2e-enquiry-message', 'Do you ship to Crete?');
  await guest.click('form.ab-form button[type="submit"]');

  await expect(guest.locator('.ab-form-status')).toContainText(/received|sent|thank/i, { timeout: 10_000 });
  await expect(guest.locator('.ab-form-error')).toHaveText('');
  // The form clears, so somebody does not send the same thing twice.
  await expect(guest.locator('#f-e2e-enquiry-name')).toHaveValue('');

  // The submission is NOT readable by the person who sent it, or anyone else.
  const anonRead = await guest.request.get('/api/content/e2e-enquiry');
  expect(anonRead.status()).toBe(404);
  await visitor.close();

  // Staff see it.
  const staffRead = await request.get('/api/content/e2e-enquiry', {
    headers: { Cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ') },
  });
  expect(staffRead.status()).toBe(200);
  const entries = (await staffRead.json()).data ?? [];
  expect(entries.some((e: any) => e.data?.message === 'Do you ship to Crete?')).toBe(true);

  // A type that never asked for submissions has no form page, even though the
  // type itself exists. This is the gate, not the "unknown name" case below.
  const staffOnlyForm = await request.get('/forms/e2e-internal');
  expect(staffOnlyForm.status()).toBe(404);

  // And a name that is nothing at all answers identically, so the page cannot
  // be used to find out which collections a site has.
  const noForm = await request.get('/forms/e2e-nothing');
  expect(noForm.status()).toBe(404);

  // Cleaned up: workers: 1 and one shared server, so a type left behind is a
  // landmine for whatever runs next.
  await page.evaluate(async () => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
    await fetch('/api/content-types', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '[]',
    });
  });
});
