import { randomBytes } from 'node:crypto';
/**
 * First-boot seed data, shared by every storage driver so a fresh database
 * behaves identically whether it's lowdb (JSON file), the libSQL doc-blob
 * adapter, or the relational SqlStorage driver.
 *
 * `makeDefaultData()` returns a fresh document (timestamps stamped at call
 * time); `makeSeedAdmin()` returns the bootstrap admin (operators are expected
 * to change the password immediately).
 */
import crypto from 'node:crypto';
import { hashPasswordSync, isProductionRuntime } from './auth';
import type { DatabaseSchema, Post, User } from '../core/models';

const id = () => crypto.randomUUID();

/**
 * Stable id for the seeded admin, so the sample posts can be authored by the
 * account that actually owns the install rather than by an invented person.
 */
export const SEED_ADMIN_ID = 'seed-admin';

/**
 * Is this the well-known seeded password?
 *
 * Exported so the login path can refuse it in production. Once this project is
 * public, `admin` is not a default — it is a published credential, and every
 * deployment that kept it is one `/login` scan away from takeover.
 */
export const SEED_PASSWORD = 'admin';

/**
 * The address the bootstrap admin gets when the operator names none.
 *
 * `admin@local` is not a deliverable address, and that is the point: it is
 * obviously a placeholder, so nothing silently mails into a void believing it
 * reached somebody. What it cannot do is receive a password reset — which is
 * why `ADMIN_EMAIL` exists.
 */
export const DEFAULT_ADMIN_EMAIL = 'admin@local';

/**
 * The bootstrap admin's address: `ADMIN_EMAIL`, or the placeholder.
 *
 * Read at CALL time rather than captured in a module constant, because the
 * storage drivers import this module long before the env is necessarily
 * settled, and a constant frozen at import time is how an operator's
 * `ADMIN_EMAIL` silently does nothing.
 *
 * A malformed value falls back rather than throwing. Refusing to boot over a
 * typo in an optional variable would turn a cosmetic mistake into an outage,
 * and an admin account that cannot be logged into is worse than a placeholder
 * address — so the fallback is announced instead.
 */
export function seedAdminEmail(): string {
  const raw = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!raw) return DEFAULT_ADMIN_EMAIL;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) && raw.length <= 200) return raw;
  console.warn(
    `AstroBaaS: ADMIN_EMAIL="${raw}" is not a usable address; ` +
    `seeding the bootstrap admin as ${DEFAULT_ADMIN_EMAIL} instead.`,
  );
  return DEFAULT_ADMIN_EMAIL;
}

/** The password the bootstrap admin is created with, and whether it is generated. */
function bootstrapPassword(): { password: string; generated: boolean } {
  const fromEnv = (process.env.ADMIN_PASSWORD || '').trim();
  if (fromEnv) return { password: fromEnv, generated: false };

  // Outside development, never fall back to a well-known string. A random
  // password printed once is strictly better than a shared secret: the operator
  // has to copy it, which is the point.
  //
  // D2-7: this used to read `process.env.NODE_ENV === 'production'` directly,
  // which is set by `npm start` but NOT by the documented bare-metal path
  // (`node ./dist/server/entry.mjs` under systemd, Docker or PM2). Those
  // installs — real, internet-facing ones — silently seeded `admin`/`admin`.
  // `isProductionRuntime()` keys on the BUILD instead, so it cannot be
  // forgotten at deploy time.
  if (isProductionRuntime()) {
    const generated = randomBytes(18).toString('base64url');
    return { password: generated, generated: true };
  }
  return { password: SEED_PASSWORD, generated: false };
}

/**
 * The bootstrap admin seeded on first boot when the install has no admin yet.
 *
 * The address comes from `ADMIN_EMAIL` when set, so the account that owns the
 * install can actually receive a password reset. Unset, it is the obvious
 * placeholder `admin@local`.
 *
 * The display name comes from `ADMIN_NAME` so a fresh install carries the
 * operator's own byline instead of a placeholder — set it before `npm run setup`
 * and the sample posts are already attributed correctly.
 *
 * The password comes from `ADMIN_PASSWORD` when set. In production with no
 * `ADMIN_PASSWORD`, a random one is generated and printed ONCE to stdout —
 * because a default credential in a public repo is a published credential.
 */
export function makeSeedAdmin(): User {
  const { password, generated } = bootstrapPassword();
  // The synchronous hash, deliberately: this runs once, when an empty database
  // is first opened, inside driver init code that is synchronous — never on a
  // request. See `hashPasswordSync` in lib/auth.ts.
  const { hash, salt } = hashPasswordSync(password);
  const now = new Date().toISOString();
  if (generated) {
    // Printed once, on first boot only. Nothing logs it again and it is not
    // recoverable — a reset goes through `npm run reset-password`.
    console.log(
      '\n' +
      '  ┌──────────────────────────────────────────────────────────────┐\n' +
      '  │  AstroBaaS: generated an admin password for this install.    │\n' +
      '  │  It is shown ONCE and is not stored anywhere in plain text.  │\n' +
      '  └──────────────────────────────────────────────────────────────┘\n' +
      `      email:    ${seedAdminEmail()}\n` +
      `      password: ${password}\n\n` +
      '  Set ADMIN_PASSWORD before first boot to choose your own.\n',
    );
  }
  return {
    id: SEED_ADMIN_ID,
    name: (process.env.ADMIN_NAME || '').trim() || 'Admin',
    email: seedAdminEmail(),
    role: 'admin',
    password_hash: hash,
    password_salt: salt,
    status: 'active',
    posts_count: 0,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Should a fresh install come with the two demo blog posts?
 *
 * They exist so an empty CMS has something to look at. On a real shop they are
 * a liability: an optician's live dashboard led with "Getting Started with
 * AstroBaaS" and "Building Lightning-Fast Websites (1.2K views)" — invented
 * traffic on someone's business.
 *
 * Set `SEED_DEMO_CONTENT=0` before first boot to skip them. Off by opt-out
 * rather than opt-in because a brand-new CMS with literally nothing in it is a
 * worse first run for the majority, and this only affects the FIRST boot of an
 * empty database.
 *
 * **It does not remove posts from an install that already has them.** Seeding
 * runs once, on an empty store; an existing shop showing the demo posts has to
 * delete them in Admin → Posts.
 */
function seedDemoContent(): boolean {
  const raw = (process.env.SEED_DEMO_CONTENT ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no');
}

/** A fresh default document with sample content + the default active theme. */
export function makeDefaultData(): DatabaseSchema {
  const now = new Date().toISOString();
  // Annotated: pulled out of the DatabaseSchema literal it loses contextual
  // typing, and `status: 'published'` widens to `string`.
  const demoPosts: Post[] = !seedDemoContent() ? [] : [
      {
        id: '1',
        title: 'Welcome to AstroBaaS',
        slug: 'welcome-to-astrobaas',
        content:
          '<p>You are looking at AstroBaaS — the CMS running this site. This post came with the installation, so edit or delete it once you have had a look around.</p><h2>What it is</h2><p>One program that runs your website and stores everything it needs. There is no separate database server to install, no build step to publish a post, and no hosting account required. It runs on a small server you control.</p><h2>What you can do right now</h2><ul><li><strong>Write.</strong> The editor is under Posts — headings, lists, links and images, with autosave and full revision history, so you can always roll back.</li><li><strong>Add pictures.</strong> Every image you upload is converted to WebP and stripped of its hidden data, including GPS location, before it is stored.</li><li><strong>Sell things.</strong> Products, stock, orders, customers, shipping and tax are built in, not an add-on.</li><li><strong>Invite people.</strong> Five roles, from full administrator down to a shop manager who runs the catalogue but cannot change your settings.</li><li><strong>Change how it looks.</strong> Themes and plugins install from the admin, most without a restart.</li></ul><h2>Where your content lives</h2><p>In your own database and your own uploads folder, on your own server. You can back the whole site up as a single file from Tools, and nothing is sent anywhere unless you configure it to be.</p><h2>Two things worth doing first</h2><ul><li><strong>Change your password.</strong> The dashboard will keep reminding you until you do.</li><li><strong>Set your site name and address</strong> under Settings, so links, search-engine listings and feeds point at the right place.</li></ul><p>If you would rather use AstroBaaS as a backend for a site you build yourself, it does that too — the next two posts cover it.</p>',
        excerpt: 'What AstroBaaS is, what you can do with it right now, and the two things worth doing first.',
        status: 'published',
        author_id: SEED_ADMIN_ID,
        category_id: '1',
        tags: ['getting-started'],
        // Zero, not an invented number. A seeded post has been read by nobody,
        // and a dashboard that opens with fabricated engagement is lying to the
        // one person who cannot check it.
        views: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: '2',
        title: 'Two ways to use AstroBaaS',
        slug: 'two-ways-to-use-astrobaas',
        content:
          '<p>AstroBaaS works in two quite different ways, and you can switch between them without moving your content.</p><h2>1. As a normal website</h2><p>Write posts and pages in the admin and they appear on your site immediately — there is no rebuild and no deploy step. Pages are rendered on the server, so a visitor gets finished HTML and very little JavaScript: a cookie-consent manager, and the AI assistant if you switch it on.</p><h2>2. As a backend for your own front end</h2><p>Point any site at the API and use AstroBaaS purely for content, products, orders and files. The next post covers this in detail.</p><h2>Extending it</h2><ul><li><strong>Plugins</strong> add behaviour: filters over your content, extra tags in the page head, editor blocks, new content types, webhook subscriptions. Simple ones are a single JSON file you install from the admin with no restart.</li><li><strong>Themes</strong> change the look, from colours and fonts up to replacing whole page templates.</li></ul><h2>Storing your data</h2><p>Start on a plain JSON file — easy to read, easy to back up, and fine for a normal site. Move to SQLite or libSQL when you want durability across restarts or more than one server, by changing one setting. Your content comes with you.</p><h2>Honest limits</h2><p>AstroBaaS is pre-alpha. <strong>CHANGELOG.md</strong> says what works, and <strong>CHANGELOG.md</strong> is the honest record of what landed and what is still missing — including the ones that do not hold up yet. If something here does not match what you see, that second document is the one that is right.</p>',
        excerpt: 'As a normal website, or as a backend for a front end you build yourself — and how to extend either.',
        status: 'published',
        author_id: SEED_ADMIN_ID,
        category_id: '2',
        tags: ['guide'],
        views: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: '3',
        title: 'Using AstroBaaS as a headless backend',
        slug: 'using-astrobaas-as-a-headless-backend',
        content:
          '<p>You do not have to use the pages AstroBaaS renders. It works just as well as a headless backend: you build the front end, and AstroBaaS handles content, products, orders, customers, files and authentication behind it.</p><h2>What that gives you</h2><ul><li><strong>A REST API</strong> over everything — posts, pages, products, orders, categories, media, settings.</li><li><strong>A full description at <code>/openapi.json</code></strong>, so your editor, your client generator or your AI assistant can read the contract instead of guessing it.</li><li><strong>Scoped API keys.</strong> A key grants only the resources you name and is denied everything else by default, so a storefront key cannot touch your users.</li><li><strong>CORS you configure</strong>, so a front end on another domain can call it directly from the browser.</li><li><strong>Signed webhooks</strong> when content or orders change, so your front end can rebuild or revalidate without polling.</li></ul><h2>If you build with an AI assistant</h2><p>This part was designed for you rather than bolted on afterwards.</p><ul><li><strong><code>/llms.txt</code></strong> is a short, plain-text tour of the whole API written for a language model to read — endpoints, roles, and what each one needs.</li><li><strong>An MCP server</strong> ships with the project, exposing 33 tools so an agent can operate the backend directly: create posts, manage the catalogue, upload media, read settings.</li><li><strong>Predictable responses.</strong> Every endpoint answers with the same envelope, so generated code that handles one call handles all of them.</li></ul><p>The practical effect is that you can describe the site you want, let an assistant build the front end against a real API, and still have a proper admin panel for whoever runs the site afterwards — which is usually not the person who built it.</p><h2>One caveat, while it is still true</h2><p>AstroBaaS is not published to npm yet, so you cannot install the typed client into a separate project. Talk to it over plain HTTP in the meantime — that is what the API and <code>/openapi.json</code> are for, and nothing about the integration depends on the client library. See <strong>INTEGRATION.md</strong> in the repository.</p>',
        excerpt: 'Bring your own front end — REST, OpenAPI, scoped keys, CORS and webhooks, plus an MCP server and /llms.txt for AI-built sites.',
        status: 'published',
        author_id: SEED_ADMIN_ID,
        category_id: '2',
        tags: ['guide', 'headless'],
        views: 0,
        created_at: now,
        updated_at: now,
      },
    ];

  return {
    posts: demoPosts,
    categories: [
      { id: '1', name: 'Getting started', slug: 'getting-started', description: 'First steps with AstroBaaS', created_at: now, updated_at: now },
      { id: '2', name: 'Guides', slug: 'guides', description: 'How to use and extend AstroBaaS', created_at: now, updated_at: now },
    ],
    // No invented demo users. The sample posts are authored by the seeded
    // admin — the account whoever installs this actually holds — so a fresh
    // site never publishes content under a fictional byline, and there are no
    // extra admin-role rows sitting in the users table for no reason.
    users: [],
    media: [],
    shippingMethods: [],
    coupons: [],
    counters: {},
    themes: [
      {
        id: 'default',
        name: 'AstroBaaS Default',
        description: 'Clean and modern default theme for AstroBaaS',
        version: '1.0.0',
        author: 'AstroBaaS Team',
        status: 'active',
        settings: {
          colors: { primary: '#3B82F6', secondary: '#8B5CF6', accent: '#10B981', background: '#FFFFFF', text: '#1F2937' },
          typography: { headingFont: 'Inter', bodyFont: 'Inter', fontSize: '16px' },
        },
        created_at: now,
      },
    ],
    settings: [
      { id: '1', key: 'site_title', value: 'AstroBaaS', category: 'general', created_at: now, updated_at: now },
      { id: '2', key: 'site_tagline', value: 'Modern CMS for the Future Web', category: 'general', created_at: now, updated_at: now },
    ],
    themeSettings: [],
    contentChanges: [],
    messages: [],
    subscribers: [],
    plugins: [],
    custom: {},
    apiKeys: [],
    webhooks: [],
    webhookDeliveries: [],
    auditEvents: [],
    consentReceipts: [],
    emailLog: [],
    products: [],
    brands: [],
    productCategories: [],
    orders: [],
    customers: [],
  };
}
