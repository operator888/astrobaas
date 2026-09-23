/**
 * Versioned schema migrations + upgrade runner.
 *
 * AstroBaaS stores every entity as a JSON document (lowdb file, libSQL doc-blob,
 * or per-entity relational rows), so "schema" changes are DATA transforms rather
 * than DDL. Each migration therefore operates through the storage-agnostic
 * `Storage` interface, which means ONE migration definition upgrades all three
 * drivers identically.
 *
 * Contract for every migration:
 *   - `version` is the version the database is AT once `up` completes.
 *   - `up` MUST be idempotent — safe to run twice, and a no-op when the data is
 *     already in the target shape (so re-runs and fresh installs can't corrupt).
 *   - Migrations run in ascending `version` order, each stamped atomically after
 *     it succeeds. A throw aborts the run and leaves the version at the last
 *     successful step, so a failed upgrade never half-applies past that point.
 *
 * The runner is invoked once per process from LocalDB.init() (see localdb.ts).
 * A fresh install is stamped at LATEST_SCHEMA_VERSION at seed time, so only a
 * pre-existing database ever has migrations applied to it.
 */
import type { Storage } from '../core/storage';
import { brandKey, normalizeBrand, relatedBrandPairs, summarizeBrands } from './commerce/brand';
import type { SavedAddress, ThemeConfig } from '../core/models';
import { defaultLocale } from './i18n';

export interface Migration {
  /** Version the DB is AT after this migration applies. Ascending, gap-free. */
  version: number;
  /** Short kebab-case identifier, shown in logs. */
  name: string;
  /** Idempotent forward transform. */
  up(storage: Storage): Promise<void>;
}

/**
 * Ordered migration list. Append new entries with the next integer version;
 * never renumber or edit a shipped migration (append a corrective one instead).
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: 'backfill-user-status',
    // Role/permission gating treats `status === 'active'` as the sole "enabled"
    // signal (see middleware + users routes). A user record from a very old
    // build, or a hand-edited db.json, might lack `status` entirely — which
    // would read as not-active and silently lock that account out. Backfill any
    // missing/blank status to 'active'. Idempotent: only touches deficient rows.
    async up(storage) {
      const users = await storage.getUsers();
      for (const u of users) {
        if (u.status !== 'active' && u.status !== 'inactive') {
          await storage.updateUser(u.id, { status: 'active' });
        }
      }
    },
  },
  {
    version: 3,
    name: 'drop-dead-theme-layout',
    // ThemeConfig.layout (headerStyle/footerStyle/sidebarPosition) was stored,
    // API-exposed and admin-visible, but NO template ever read it — config that
    // implied theming capability the renderer doesn't have. The field is gone
    // from the model; strip it from stored themes so the persisted shape matches.
    // Idempotent: only rewrites themes that still carry the key.
    async up(storage) {
      const themes = await storage.getThemes();
      for (const t of themes) {
        const settings = t.settings as unknown as Record<string, unknown> | undefined;
        if (settings && Object.prototype.hasOwnProperty.call(settings, 'layout')) {
          const { layout, ...rest } = settings;
          void layout;
          await storage.updateThemeSettings(t.id, rest as unknown as ThemeConfig);
        }
      }
    },
  },
  {
    version: 4,
    name: 'backfill-post-locale',
    // i18n (schema v4) adds Post.locale. Existing posts predate it, so stamp
    // them with the configured default locale. Readers already treat a missing
    // locale as the default, so this migration is a data-consistency step rather
    // than a correctness fix — it makes locale filtering exact instead of
    // inferred, and lets the admin show a real value. Idempotent: only touches
    // posts with no valid locale.
    async up(storage) {
      const fallback = defaultLocale();
      const posts = await storage.getPosts();
      for (const p of posts) {
        if (!p.locale) {
          await storage.updatePost(p.id, { locale: fallback });
        }
      }
    },
  },
  {
    version: 5,
    name: 'backfill-order-payment-status',
    // Payment providers (schema v5) split "is the money here" (payment_status)
    // from "are we working on it" (status). Orders written before the split
    // have neither field. Stamp them explicitly rather than letting readers
    // infer, so an admin filtering for unpaid orders sees the truth.
    //
    // The inference is deliberately conservative: an order that already reached
    // completed/processing was accepted by a human under the old model, so it
    // counts as paid; cancelled/refunded map to their payment equivalents;
    // anything still pending is 'unpaid', because under the old model nothing
    // had collected money. Idempotent — only touches orders with no status.
    async up(storage) {
      const orders = await storage.getOrders();
      for (const o of orders) {
        if (o.payment_status) continue;
        const inferred =
          o.status === 'completed' || o.status === 'processing'
            ? 'paid'
            : o.status === 'refunded'
              ? 'refunded'
              : o.status === 'cancelled'
                ? 'failed'
                : 'unpaid';
        await storage.updateOrder(o.id, { payment_status: inferred });
      }
    },
  },
  {
    version: 6,
    name: 'backfill-product-commerce-defaults',
    // The extended catalogue fields (schema v6) are all optional, and readers
    // already treat absent as the safe default. This makes those defaults
    // EXPLICIT so the admin shows a real value, filters behave, and a CSV
    // export has columns instead of blanks.
    //
    // Deliberately conservative on the two that can change behaviour:
    //   - backorders defaults to 'no', the only policy that cannot oversell;
    //   - manage_stock is inferred from whether a count already exists, so an
    //     untracked product does not suddenly start tracking at zero.
    // Idempotent: only fills fields that are absent.
    async up(storage) {
      const products = await storage.getProducts();
      for (const p of products) {
        const patch: Record<string, unknown> = {};
        if (p.backorders === undefined) patch.backorders = 'no';
        if (p.manage_stock === undefined) patch.manage_stock = p.stock !== null && p.stock !== undefined;
        if (p.catalog_visibility === undefined) patch.catalog_visibility = 'visible';
        if (p.tax_status === undefined) patch.tax_status = 'taxable';
        if (p.sold_individually === undefined) patch.sold_individually = false;
        if (p.virtual === undefined) patch.virtual = false;
        if (p.downloadable === undefined) patch.downloadable = false;
        if (p.reviews_enabled === undefined) patch.reviews_enabled = true;
        // A virtual product is never shipped; everything else is, by default.
        if (p.requires_shipping === undefined) patch.requires_shipping = p.virtual !== true;
        if (p.tags === undefined) patch.tags = [];
        if (Object.keys(patch).length) await storage.updateProduct(p.id, patch);
      }
    },
  },
  {
    version: 7,
    name: 'backfill-order-money-breakdown',
    // Orders placed before tax/shipping existed have only `total_cents`, which
    // WAS the whole truth then: no shipping was charged and no tax computed, so
    // the total genuinely equalled the sum of lines.
    //
    // Stamping that explicitly makes historical orders renderable by the same
    // invoice code as new ones, instead of every consumer having to special-case
    // `subtotal_cents === undefined`. It does NOT invent a tax split: claiming a
    // VAT figure for an order where none was calculated would be inventing a tax
    // record, which is worse than an obviously-absent one.
    async up(storage) {
      const orders = await storage.getOrders();
      for (const o of orders) {
        if (o.subtotal_cents !== undefined) continue;
        const lineSum = (o.items ?? []).reduce((n, i) => n + (i.total_cents ?? 0), 0);
        await storage.updateOrder(o.id, {
          subtotal_cents: lineSum || o.total_cents || 0,
          discount_cents: 0,
          shipping_cents: 0,
          tax_cents: 0,
        });
      }
    },
  },
  {
    version: 8,
    name: 'ensure-commerce-collections',
    // shippingMethods / coupons / counters are new collections. A document
    // written before them has no such key, and a create would have pushed onto
    // undefined. The storage helpers now create the array on demand too, so
    // this migration is belt-and-braces — but an operator who inspects the
    // database should find the shape they expect, not a missing key.
    async up(storage) {
      // Touching each collection is enough: every driver materialises an empty
      // one on read, and the lowdb document is rewritten by the version stamp.
      await storage.getShippingMethods().catch(() => []);
      await storage.getCoupons().catch(() => []);
    },
  },
  {
    version: 9,
    name: 'backfill-theme-style-defaults',
    // The extended token set (semantic colours, type scale, radius, density,
    // shadow, container width, button + header style, colour scheme) is all
    // optional, and /theme.css already falls back to the :root defaults in
    // global.css when a value is absent.
    //
    // So this is for the ADMIN, not for correctness: without it the customizer
    // renders every new <select> at its first option regardless of what the
    // site actually looks like, and the next Save would write that back — the
    // same silent-overwrite shape as the font <select> bug. Filling the stored
    // defaults makes the form show the truth.
    //
    // A theme customized before this migration looks pixel-identical after it.
    // Idempotent: only fills fields that are absent.
    async up(storage) {
      const themes = await storage.getThemes();
      for (const t of themes) {
        const cfg: any = t.settings;
        if (!cfg || typeof cfg !== 'object') continue;
        const patch: any = { ...cfg };
        let changed = false;
        const fill = (obj: any, key: string, value: unknown) => {
          if (obj[key] === undefined) { obj[key] = value; changed = true; }
        };

        patch.colors = { ...(cfg.colors ?? {}) };
        fill(patch.colors, 'surface', '#ffffff');
        fill(patch.colors, 'muted', '#6b7280');
        fill(patch.colors, 'border', '#e5e7eb');

        patch.typography = { ...(cfg.typography ?? {}) };
        fill(patch.typography, 'scale', 'normal');
        fill(patch.typography, 'headingWeight', 'bold');

        patch.style = { ...(cfg.style ?? {}) };
        fill(patch.style, 'radius', 'md');
        fill(patch.style, 'density', 'normal');
        fill(patch.style, 'shadow', 'soft');
        fill(patch.style, 'containerWidth', 'normal');
        fill(patch.style, 'buttonStyle', 'solid');
        fill(patch.style, 'headerStyle', 'split');

        fill(patch, 'colorScheme', 'light');

        if (changed) await storage.updateThemeSettings(t.id, patch);
      }
    },
  },

  {
    version: 10,
    name: 'backfill-media-thumbnails',
    // The 400px WebP derivative was generated on upload and attached to the
    // RESPONSE object after the record was created, so it never reached the
    // database. Every existing row therefore has no `thumb_url`, and the
    // library renders the full-resolution original for each tile.
    //
    // The derivative file usually EXISTS on disk (upload wrote it); only the
    // pointer was lost. Filenames are content-addressed, so the sibling is
    // derivable: <hash>.<ext> -> <hash>-thumb.webp.
    //
    // Conservative: this records a pointer, it does not create or delete
    // files, and it only fills rows that have none. A row whose sibling is
    // missing keeps falling back to the original, which is exactly today's
    // behaviour — so the worst case is no change.
    async up(storage) {
      const media = await storage.getMedia();
      for (const m of media) {
        const rec = m as { id: string; url?: string; thumb_url?: string; mime_type?: string };
        if (rec.thumb_url) continue;
        if (!rec.url || !rec.url.startsWith('/uploads/')) continue;
        if (!rec.mime_type?.startsWith('image/')) continue;
        const guess = rec.url.replace(/\.[^./]+$/, '-thumb.webp');
        if (guess === rec.url) continue;
        await storage.updateMediaFile(rec.id, { thumb_url: guess });
      }
    },
  },

  {
    version: 11,
    name: 'activate-optical-module-for-existing-optical-shops',
    // Prescription validation moved out of core checkout and into the
    // `optical` bundled plugin. Bundled plugins are seeded INACTIVE, so
    // without this an upgrade would silently stop validating prescriptions:
    // an order for spectacle lenses would be accepted with no Rx at all, and
    // reach the lab as a line item with nothing to grind. Nothing would error.
    //
    // So: any install that was ALREADY selling optical goods gets the module
    // switched on, restoring exactly the behaviour it had before the upgrade.
    //
    // Evidence-based rather than unconditional. A shop that has never sold a
    // prescription product is a general shop, and turning an eyewear vertical
    // on for it would be this migration inventing a decision the operator did
    // not make. Two independent signals, because either one alone can be
    // absent on a real shop:
    //
    //   * a product marked `requires_prescription` — the catalogue says so;
    //   * a historical order line carrying a `prescription` — the sales say so
    //     even if the product was since archived or the flag was cleared.
    //
    // Idempotent: it only ever turns the plugin ON, and only when it is
    // currently off, so re-running changes nothing. It never turns it off —
    // an operator who deliberately deactivates the module must not have that
    // decision reverted by a later boot.
    async up(storage) {
      // ORDERING, and the reason this migration seeds its own record.
      //
      // Migrations run inside LocalDB.init(), which ensurePluginsBootstrapped()
      // calls BEFORE it seeds bundled plugins. So at this moment there is no
      // `optical` record yet, and an earlier version of this migration that
      // bailed on "no record" did nothing at all: the boot then seeded the
      // plugin INACTIVE and prescription validation silently stopped. Verified
      // against a real v10 database booted by the new build — the Rx product
      // sold with no prescription.
      //
      // ensurePlugins() only creates ids that are missing and never touches an
      // existing record's `active`, so seeding here is safe: this migration
      // wins, and the later boot-time seeding leaves the result alone.
      const before = await storage.getPlugins();
      const record = before.find((p) => p.id === 'optical');
      // Already switched on, or deliberately switched off by an operator on a
      // later boot — either way this migration has had its say.
      if (record?.active) return;

      const products = await storage.getProducts();
      let optical = products.some(
        (p) => (p as { requires_prescription?: boolean }).requires_prescription === true,
      );

      if (!optical) {
        const orders = await storage.getOrders();
        optical = orders.some((o) =>
          ((o as { items?: { prescription?: unknown }[] }).items ?? [])
            .some((i) => i?.prescription != null));
      }

      if (!optical) return;
      // Create the record if the boot has not yet seeded it, then switch it on.
      if (!record) await storage.ensurePlugins(['optical']);
      await storage.setPluginActive('optical', true);
    },
  },

  {
    version: 12,
    name: 'enable-commerce-where-a-shop-already-exists',
    // Commerce became opt-in (`commerce_enabled`, absent = off) so that a
    // fresh install is not a shop by accident. Every install that predates
    // the switch and IS a shop must therefore be told it may keep selling —
    // silence here would 404 two production storefronts on their next deploy.
    //
    // Evidence-based like v11: products in the catalogue or orders in the
    // book mean somebody set a shop up, whether or not it sold anything yet.
    // One-directional and idempotent: it only ever writes `true`, and only
    // when the operator has never touched the setting — an explicit `false`
    // saved later is a decision this migration must never revert on a boot.
    // It also never writes `false`: absence already means off, and a stored
    // `false` the operator did not choose would masquerade as one they did.
    async up(storage) {
      if ((await storage.getSetting('commerce_enabled')) !== undefined) return;
      const hasProducts = (await storage.getProducts()).length > 0;
      const hasOrders = hasProducts ? true : (await storage.getOrders()).length > 0;
      if (hasProducts || hasOrders) {
        await storage.updateSetting('commerce_enabled', true);
      }
    },
  },


  {
    version: 13,
    name: 'structured-addresses-from-existing-customer-fields',
    // Customers gained an address BOOK, and their existing address is lifted
    // into it so a repeat buyer's first checkout after the upgrade already has
    // something to pick.
    //
    // THIS IS A LIFT, NOT A PARSE, and the difference is the whole reason it is
    // safe. A Customer record already stores city, postcode and country as
    // separate fields, so every mapping here is 1:1 and claims nothing the data
    // does not already say. `address -> line1` asserts only "this is the first
    // line", which is true by construction.
    //
    // IT TOUCHES NO ORDER, DELIBERATELY. Splitting an order's flat
    // "Οδός Ερμού 15, 3ος, 10563 Αθήνα" into fields is a guess, and a guessed
    // postcode is a courier label to the wrong depot or a VAT figure re-derived
    // against the wrong zone. v7 set this precedent by refusing to invent a tax
    // split. The asymmetry with customers is the point: a Customer record is a
    // CURRENT fact about a living person that staff can correct, while an Order
    // is a HISTORICAL record that must never change retroactively.
    //
    // It never writes a country it cannot verify. A `country` of "Greece"
    // rather than "GR" yields NO country on the saved address — the legacy
    // field keeps the value, so nothing is lost and the admin can repair it.
    // Writing 'GR' because the string looks Greek is invention; dropping the
    // value outright is data loss; leaving it where it already is, is the
    // honest third option.
    //
    // Idempotent and additive: guarded on `addresses` being absent, it writes
    // nothing for a customer with nothing to lift, and it removes no legacy
    // field. An install with no customers is byte-identical afterwards.
    async up(storage) {
      const customers = await storage.getCustomers();
      for (const c of customers) {
        if (Array.isArray((c as { addresses?: unknown[] }).addresses)) continue;
        const hasSomething = Boolean(c.address || c.city || c.postcode || c.phone || c.name);
        if (!hasSomething) continue;

        const country = typeof c.country === 'string' && /^[A-Za-z]{2}$/.test(c.country.trim())
          ? c.country.trim().toUpperCase()
          : undefined;

        const saved: SavedAddress = {
          // Deterministic, so a re-run after a partial failure cannot mint a
          // second copy with a fresh uuid.
          id: `legacy-${c.id}`,
          label: 'Imported',
          default_shipping: true,
          default_billing: true,
        };
        if (c.name) saved.name = c.name;
        if (c.phone) saved.phone = c.phone;
        if (c.address) saved.line1 = c.address;
        if (c.city) saved.city = c.city;
        if (c.postcode) saved.postcode = c.postcode;
        if (country) saved.country = country;

        await storage.updateCustomer(c.id, { addresses: [saved] });
      }
    },
  },


  {
    version: 14,
    name: 'classify-existing-gallery-video',
    // A product gallery is one array and `kind` was only ever written on SAVE,
    // so every entry stored before that field existed — and every entry written
    // by an import path — is on the wire as `{ src }`, byte-identical to a
    // photograph. A storefront told to trust `kind` would regress on exactly
    // those rows.
    //
    // The API now derives kind on READ, so this migration is a data-consistency
    // step rather than the fix: it makes the STORED rows agree with what the
    // API already reports, so an operator reading the database sees the same
    // answer the storefront does.
    //
    // THE MEDIA TABLE IS THE SOURCE OF TRUTH. Its `mime_type` is recorded from
    // the upload sniffer, which reads magic bytes. The extension is the
    // fallback, and it is a good one here rather than a guess: the ingester
    // NAMES a file from the sniffed type, so for anything this CMS ingested the
    // two cannot disagree. For a src that matches no media row — an imported
    // catalogue pointing at somebody else's CDN — the extension is the only
    // answer available, and refusing to use it would leave the row exactly as
    // broken as it is now.
    //
    // Add-only: it writes `kind: 'video'` and never removes one, never touches
    // a photograph, and never writes a product it did not change. A shop with
    // no videos is byte-identical afterwards.
    async up(storage) {
      const media = await storage.getMedia();
      const mimeByUrl = new Map<string, string>();
      for (const m of media) {
        if (typeof m?.url === 'string' && typeof m.mime_type === 'string') mimeByUrl.set(m.url, m.mime_type);
      }
      const isVideo = (src: string) => {
        const mime = mimeByUrl.get(src);
        if (mime) return mime.startsWith('video/');
        return /\.(mp4|webm)(?:[?#]|$)/i.test(String(src || ''));
      };

      for (const product of await storage.getProducts()) {
        const images = product.images;
        if (!Array.isArray(images) || !images.length) continue;
        let changed = false;
        const next = images.map((img) => {
          if (!img || typeof img.src !== 'string') return img;
          if (img.kind === 'video') return img;
          if (!isVideo(img.src)) return img;
          changed = true;
          return { ...img, kind: 'video' as const };
        });
        // No write when nothing moved: updateProduct stamps `updated_at` and
        // pushes a change-feed entry on every driver, so a no-op sweep across a
        // catalogue would flush the 1000-entry ring and re-date every product.
        if (changed) await storage.updateProduct(product.id, { images: next });
      }
    },
  },

  {
    version: 15,
    name: 'canonical-brand-spellings',
    // One maker, spelled one way — but only where the catalogue itself says so.
    //
    // A live shop's 447 products held 72 distinct brand strings for 62 makers.
    // Shoppers are already unaffected: `?brand=`, the brands listing and the
    // automatic-collection rules all group by `brandKey` on READ, so the fix
    // needed no migration. This is the tidy-up — it makes the STORED spelling
    // agree with what every surface already displays.
    //
    // ## Why it refuses more than it does
    //
    // "Pick the most common spelling" is the right instinct and a dangerous
    // rule on its own. Two guards keep it honest:
    //
    //  1. **Only case and whitespace may be merged automatically.** Within one
    //     `brandKey` group, spellings can still differ by punctuation —
    //     `Ray-Ban` and `Rayban` fold together, and the more common one is the
    //     WRONG one. So a group whose members differ by anything but case and
    //     spacing is reported, never rewritten.
    //  2. **A winner needs two thirds of its group.** `DALET` (6) beats `Dalet`
    //     (4) on a bare count, and applying that would rewrite four products
    //     into the shoutier spelling on a 60/40 split that is not evidence of
    //     anything. Below two thirds it is a question for a human.
    //
    // It never merges across groups, so `Tipi Diversi` and `Tipi Diversi Clip`
    // — genuinely different product lines in that shop — are untouchable here:
    // an extra word is an extra key. `SOLANO` likewise stays apart from
    // `Solano Clips`. Those near-misses are REPORTED as suggestions, because a
    // wrong automatic merge moves products to a maker nobody will look under.
    //
    // Add-only in spirit: it rewrites `brand` and nothing else, writes only the
    // products whose spelling actually changes (v14's note explains why a no-op
    // sweep is expensive), and is idempotent — a second run finds every group
    // already unanimous and writes nothing.
    async up(storage) {
      const products = await storage.getProducts();
      const summaries = summarizeBrands(products);

      const applied: { to: string; from: string[]; products: number }[] = [];
      const needsAHuman: { name: string; reason: string; spellings: { name: string; count: number }[] }[] = [];
      const canonicalByKey = new Map<string, string>();

      for (const group of summaries) {
        if (group.spellings.length < 2) continue;
        const [winner, ...rest] = group.spellings;

        // GUARD 1 — case and whitespace only. `normalizeBrand` collapses
        // spacing, so comparing the lowercased tidy forms isolates exactly the
        // differences this migration is allowed to erase.
        const softKey = (n: string) => (normalizeBrand(n) ?? '').toLowerCase();
        const onlyCase = group.spellings.every((s) => softKey(s.name) === softKey(winner.name));
        if (!onlyCase) {
          needsAHuman.push({
            name: winner.name,
            reason: 'These differ by more than capitalisation — the most common spelling is not automatically the correct one.',
            spellings: group.spellings,
          });
          continue;
        }

        // GUARD 2 — a clear winner, not a plurality.
        if (winner.count * 3 < group.count * 2) {
          needsAHuman.push({
            name: winner.name,
            reason: `No spelling is used by two thirds of these ${group.count} products, so there is no clear house style to apply.`,
            spellings: group.spellings,
          });
          continue;
        }

        canonicalByKey.set(group.key, winner.name);
        applied.push({
          to: winner.name,
          from: rest.map((r) => r.name),
          products: group.count - winner.count,
        });
      }

      for (const product of products) {
        const raw = typeof product.brand === 'string' ? product.brand : '';
        if (!raw) continue;
        const canonical = canonicalByKey.get(brandKey(raw));
        // `normalizeBrand` also lands here for a group of ONE spelling that
        // merely needs trimming — `"Symbol "` alone is still worth tidying.
        const next = canonical ?? normalizeBrand(raw);
        if (!next || next === raw) continue;
        await storage.updateProduct(product.id, { brand: next });
      }

      const related = relatedBrandPairs(summaries);

      /*
       * The report.
       *
       * A migration gets a Storage handle and nothing else — no logger, no
       * return value an operator ever sees. The console is ephemeral and this
       * codebase already records that a small-shop operator cannot read server
       * logs. So the durable, staff-only channel is a settings row, which has
       * both a migration precedent (v12's `commerce_enabled`) and an
       * operator-report precedent (`assistant_last_error`, rendered as a panel
       * in the admin).
       *
       * Written only when there is something to say. A shop with tidy brands
       * gets no row, so the absence of a report means "nothing to report"
       * rather than "the migration did not run".
       */
      if (applied.length || needsAHuman.length || related.length) {
        await storage.updateSetting('brand_spelling_report', {
          schema_version: 15,
          applied,
          needs_a_human: needsAHuman,
          possibly_related: related,
        });
      }
    },
  },
];

/** The version a fresh install is stamped at, and the target every upgrade reaches. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  1, // baseline: the shape the current seed/models produce
);

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

/**
 * Bring `storage` up to LATEST_SCHEMA_VERSION by running every migration whose
 * version exceeds the stored one, in order, stamping after each. Returns what
 * happened (used for the startup log). Safe to call repeatedly — when already
 * current it just reads the version and returns.
 */
export async function runMigrations(
  storage: Storage,
  log: (msg: string) => void = () => {},
): Promise<MigrationResult> {
  const from = await storage.getSchemaVersion();
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    // Stamp forward if the store is behind LATEST purely due to baseline bumps
    // (no data migration needed), so the recorded version stays meaningful.
    if (from < LATEST_SCHEMA_VERSION) await storage.setSchemaVersion(LATEST_SCHEMA_VERSION);
    return { from, to: LATEST_SCHEMA_VERSION, applied: [] };
  }

  const applied: string[] = [];
  for (const m of pending) {
    log(`[astrobaas] migrating schema → v${m.version} (${m.name})…`);
    await m.up(storage);
    await storage.setSchemaVersion(m.version);
    applied.push(m.name);
  }
  // Ensure the final recorded version is exactly LATEST even if the last
  // migration's version is below it (baseline gap).
  if (LATEST_SCHEMA_VERSION > (pending[pending.length - 1]?.version ?? from)) {
    await storage.setSchemaVersion(LATEST_SCHEMA_VERSION);
  }
  log(`[astrobaas] schema migrated v${from} → v${LATEST_SCHEMA_VERSION} (${applied.length} applied)`);
  return { from, to: LATEST_SCHEMA_VERSION, applied };
}

/**
 * `runMigrations`, but at most one process at a time.
 *
 * ## The bug
 *
 * Every process runs the migrations at boot. Two replicas started together
 * (a deploy, a crash-looping unit, a CLI import beside the server) both read
 * the old version and both ran every pending step at once. Each step is
 * idempotent — safe to run TWICE — but not safe to run twice CONCURRENTLY: two
 * read-modify-write passes over the same rows interleave, and on the libSQL
 * doc-blob driver the later whole-document write silently discards the
 * earlier one's changes.
 *
 * ## The fix
 *
 * `exclusive` runs the work under the `migrations` lease (localdb.ts wires in
 * src/lib/lease.ts). A process that cannot take it waits, bounded, for the
 * holder to finish. `runMigrations` reads the version FIRST THING, inside the
 * lease — so the process that waited finds the work done and applies nothing.
 *
 * An already-current database never touches the lease: that is every boot but
 * the first after an upgrade, and it should cost one read, not a write.
 */
export async function runMigrationsExclusive(
  storage: Storage,
  log: (msg: string) => void,
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>,
  run: (storage: Storage, log: (msg: string) => void) => Promise<MigrationResult> = runMigrations,
): Promise<MigrationResult> {
  const current = await storage.getSchemaVersion();
  if (current >= LATEST_SCHEMA_VERSION) return run(storage, log);
  return exclusive(() => run(storage, log));
}
