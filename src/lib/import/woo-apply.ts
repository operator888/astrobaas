/**
 * Performing a WooCommerce plan.
 *
 * Same shape as `apply.ts`, same reasons: everything goes through `LocalDB`, so
 * the import works on all three drivers and cannot produce a record the API
 * could not have produced. The script this replaces wrote `db.json` directly,
 * which meant it did nothing at all on the two drivers a real shop runs on.
 *
 * Three things this has to get right that a blog import does not:
 *
 *  - **Money.** Every amount is already an integer number of cents by the time
 *    it reaches here, or its record was refused in the planner. Nothing here
 *    rounds, parses or defaults a price.
 *  - **References.** A product names its categories by slug and an order names
 *    its customer by WooCommerce id. Those are resolved AFTER the things they
 *    point at exist, so an order never carries a dangling customer id.
 *  - **The commerce switch.** Importing a shop is the clearest possible
 *    statement that this install is a shop. See `maybeEnableCommerce`.
 */
import { LocalDB } from '../localdb';
import { brandKey, buildBrandDirectory, normalizeBrand } from '../commerce/brand';
import { normalizeImages } from '../product-fields';
import { sanitizeHtml } from '../sanitize';
import { COMMERCE_ENABLED_KEY, resolveCommerceEnabled } from '../commerce-settings';
import { slugifyImported } from './plan';
import type { WooPlan } from './woo';
import type { Brand, Customer, Order, Post, Product, ProductCategory } from '../../core/models';

/** Where the WooCommerce id is recorded, so a second run recognises its work. */
export const WOO_ID_FIELD = 'wp_id' as const;

export interface WooApplyOptions {
  /** Report and write nothing. The default: an import is not undoable. */
  dryRun?: boolean;
  /** Bring the blog across as well as the shop. */
  includePosts?: boolean;
  /** Called after each record so a CLI can show progress. */
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface WooApplyResult {
  dryRun: boolean;
  createdProducts: number;
  createdCategories: number;
  createdBrands: number;
  createdCustomers: number;
  createdOrders: number;
  createdPosts: number;
  /**
   * Products an EARLIER run imported without their brand, given it back. Only
   * the brands the importer used to drop — see the products step.
   */
  restoredBrands: number;
  /** True when this import turned the shop on. */
  enabledCommerce: boolean;
  skipped: { label: string; reason: string }[];
  failed: { label: string; reason: string }[];
}

/**
 * Turn commerce on, if it is not already.
 *
 * The switch defaults to off so that a plain CMS install does not publish
 * cart, checkout and catalogue endpoints it has no use for. An operator who
 * has just imported a shop's products and orders is unambiguously running a
 * shop, and leaving them staring at a 404 on their own catalogue — with the
 * setting to fix it three screens away — is a worse default than turning it on.
 *
 * ONE DIRECTION ONLY. This never writes `false`. A shop that is already
 * running must not be switched off by an import, a re-run, or an import that
 * happened to contain no products.
 */
async function maybeEnableCommerce(): Promise<boolean> {
  const current = await LocalDB.getSetting(COMMERCE_ENABLED_KEY);
  if (resolveCommerceEnabled({ [COMMERCE_ENABLED_KEY]: current?.value })) return false;
  await LocalDB.updateSetting(COMMERCE_ENABLED_KEY, true);
  return true;
}

export async function applyWooImport(
  plan: WooPlan,
  authorId: string,
  opts: WooApplyOptions = {},
): Promise<WooApplyResult> {
  const dryRun = opts.dryRun !== false;
  const includePosts = opts.includePosts !== false;

  const result: WooApplyResult = {
    dryRun,
    createdProducts: 0,
    createdCategories: 0,
    createdBrands: 0,
    createdCustomers: 0,
    createdOrders: 0,
    createdPosts: 0,
    restoredBrands: 0,
    enabledCommerce: false,
    skipped: plan.skipped.map((s) => ({ label: `${s.kind}: ${s.label}`, reason: s.reason })),
    failed: [],
  };

  await LocalDB.init();

  const total = plan.brands.length + plan.categories.length + plan.products.length
    + plan.customers.length + plan.orders.length + (includePosts ? plan.posts.length : 0);
  let done = 0;
  const step = (label: string) => opts.onProgress?.(++done, total, label);

  // The catalogue as it was before this run. The brands and categories steps
  // write no product, so this is also what the products step starts from.
  const productsBefore = (await LocalDB.getProducts()) as (Product & { wp_id?: string })[];

  /*
   * Where a shop imported by an EARLIER version of this importer keeps a maker.
   *
   * That version stored `slugifyImported(name)` on each product — `rgreen` for
   * Ørgreen, `stra-e` for Straße — and the record as `{ name, slug }`, and
   * `buildBrandDirectory` attaches such a record to the products its slug
   * names, so the shop lists ONE Ørgreen. Writing the name on a NEW product of
   * that maker would split it in two: a product keyed `ørgreen` pulls the
   * record onto itself, and the old products are left behind as a second,
   * derived `rgreen` with a suffixed slug.
   *
   * So a new product joins its maker where the shop already keeps it — when no
   * product here carries any spelling of the name, and products THIS importer
   * stamped carry exactly the old slug. That pair is the signature of an
   * earlier run having written them for this maker, with or without the record
   * it also wrote. Only a slug that LOST letters matters: `ray-ban` and
   * `Ray Ban` are one key anyway, and a Greek name never had a slug to be
   * filed under (see the products step for what happened to those).
   *
   * The display name still arrives, on the record, which is what the listing
   * shows. Rewriting the old products to the name instead would move a key
   * that storefront links, collection rules and plugins may be built on, and
   * this importer does not rewrite what an earlier run wrote.
   */
  const keysBefore = new Set(productsBefore.map((p) => brandKey(p.brand)).filter(Boolean));
  const stampedBrands = new Set(productsBefore
    .filter((p) => typeof p[WOO_ID_FIELD] === 'string' && p[WOO_ID_FIELD] !== '')
    .map((p) => p.brand)
    .filter((b): b is string => typeof b === 'string' && b !== ''));
  const legacyFiling = (name: string): string | undefined => {
    const key = brandKey(name);
    if (!key || keysBefore.has(key)) return undefined;
    const old = slugifyImported(name);
    return old && brandKey(old) !== key && stampedBrands.has(old) ? old : undefined;
  };

  /* ---- brands ---- */
  {
    const existingBrands = (await LocalDB.getBrands()) as Brand[];
    const have = new Set(existingBrands.map((b) => b.slug));
    // The guard POST /api/brands applies, because this is the other way a
    // curated record gets created: a curated slug wins in the published
    // listing, so a record whose slug another brand already answers to would
    // silently re-point that brand's links and filters at this one.
    const directory = buildBrandDirectory(productsBefore, existingBrands, { includeDrafts: true });
    // The records already here, by the MAKER they describe: by name, and by
    // what the directory keys them on — for a record an earlier import wrote,
    // the products its slug names. Matching on the exact slug alone, which is
    // all this did, stopped being enough the day the slugs changed: an earlier
    // run stored Ørgreen's record as `rgreen` and this one plans `orgreen`; it
    // stored Γυαλιά Ηλίου's as the hex `ce-b3-cf-…` and this one plans
    // `gyalia-iliou`; and an operator may have curated Ray-Ban as `rb`. Each
    // would have got a SECOND record — and of two records for one maker, the
    // directory shows the later, so the import would quietly take over the
    // name and slug the shop was already publishing.
    const recordFor = new Map<string, { name: string; slug: string }>();
    const remember = (r: { name: string; slug: string }, keys: string[]) => {
      for (const k of keys) if (k && !recordFor.has(k)) recordFor.set(k, r);
    };
    for (const r of existingBrands) remember(r, [brandKey(r.name), directory.keyOfRecord(r)]);

    for (const b of plan.brands) {
      step(b.name);
      const key = brandKey(b.name);
      const legacy = legacyFiling(b.name);
      /** The key this maker's products are filed under once the run is done. */
      const filed = legacy ? brandKey(legacy) : key;
      const same = recordFor.get(key) ?? recordFor.get(filed);
      if (same) {
        result.skipped.push({ label: b.name, reason: `this brand is already here, as "${same.name}" (slug "${same.slug}")` });
        continue;
      }
      // A maker the shop keeps under an old slug gets its record under THAT
      // slug, which attaches it to those products — the record the earlier run
      // wrote, written again after somebody deleted it. Under the new slug it
      // would describe no product at all: an empty curated entry beside the
      // derived one.
      const slug = legacy ?? b.slug;
      if (have.has(slug)) {
        result.skipped.push({ label: b.name, reason: 'a brand with that slug is already here' });
        continue;
      }
      // Judged as the record it WILL be. The directory was built before this
      // run's products exist, so for a new maker `keyOfRecord` falls through
      // to the SLUG — and a slug that spells a maker already selling here
      // (`strasse` for Straße, while Strasse has products) would count as the
      // record's own brand and pass, then take `?brand=strasse` from Strasse
      // the moment Straße's products land. Every product this run writes
      // carries the name, so the name is the record's identity, and that is
      // what the guard is given; a legacy record is identified by the old
      // slug it attaches to.
      const other = directory.slugTakenBy(slug, legacy ? { name: b.name, slug } : { name: b.name });
      if (other) {
        result.skipped.push({ label: b.name, reason: `the slug "${slug}" already leads to the brand "${other.name}"` });
        continue;
      }
      result.createdBrands += 1;
      have.add(slug);
      remember({ name: b.name, slug }, [key, filed]);
      if (dryRun) continue;
      try {
        await LocalDB.createBrand({ name: b.name, slug } as Omit<Brand, 'id' | 'created_at' | 'updated_at'>);
      } catch (err) {
        result.createdBrands -= 1;
        result.failed.push({ label: b.name, reason: (err as Error).message });
      }
    }
  }

  /* ---- product categories ---- */
  {
    const have = new Set(((await LocalDB.getProductCategories()) as ProductCategory[]).map((c) => c.slug));
    for (const c of plan.categories) {
      step(c.name);
      if (have.has(c.slug)) {
        result.skipped.push({ label: c.name, reason: 'a category with that slug is already here' });
        continue;
      }
      result.createdCategories += 1;
      have.add(c.slug);
      if (dryRun) continue;
      try {
        await LocalDB.createProductCategory({
          name: c.name,
          slug: c.slug,
          ...(c.parentSlug ? { parent_slug: c.parentSlug } : {}),
        } as Omit<ProductCategory, 'id' | 'created_at' | 'updated_at'>);
      } catch (err) {
        result.createdCategories -= 1;
        result.failed.push({ label: c.name, reason: (err as Error).message });
      }
    }
  }

  /* ---- products ---- */
  const productIdByWpId = new Map<string, string>();
  {
    const haveSlug = new Set(productsBefore.map((p) => p.slug));
    /** What an earlier run left, by WooCommerce id. */
    const earlier = new Map<string, Product>();
    for (const p of productsBefore) {
      const stamp = p[WOO_ID_FIELD];
      if (typeof stamp === 'string' && stamp) {
        productIdByWpId.set(stamp, p.id);
        earlier.set(stamp, p);
      }
    }

    for (const p of plan.products) {
      step(p.name);
      const brand = normalizeBrand(p.brand);
      if (p.wpId && productIdByWpId.has(p.wpId)) {
        // A re-run changes nothing an earlier run wrote, with ONE exception: a
        // brand the earlier run LOST. Before this importer kept display names,
        // a brand with no Latin letter or digit in it — every Greek one —
        // slugified to nothing, and its products arrived with no brand at all.
        // `slugifyImported(brand) === ''` is exactly that signature, so this
        // gives those back and touches nothing else:
        //
        //  - a brand the earlier run DID store (`rgreen` for Ørgreen) stays. The
        //    record that run wrote describes those products (see
        //    `buildBrandDirectory`), so the shop already lists and filters them
        //    correctly, and storefront links and collection rules may be built
        //    on that slug — rewriting it would move them.
        //  - a product with no brand whose brand WOULD have slugified had it
        //    removed by somebody after the import, and stays as they left it.
        //  - a product that has a brand now had it set by hand, and keeps it.
        //
        // A restored brand is the NAME — such a brand has no old slug to be
        // filed under — which is where the record this run writes for it, or
        // the one the earlier run wrote, is keyed.
        const before = earlier.get(p.wpId);
        if (before && brand && !normalizeBrand(before.brand) && !slugifyImported(brand)) {
          result.restoredBrands += 1;
          if (!dryRun) {
            try {
              await LocalDB.updateProduct(before.id, { brand } as Partial<Product>);
            } catch (err) {
              result.restoredBrands -= 1;
              result.failed.push({ label: p.name, reason: (err as Error).message });
            }
          }
        }
        result.skipped.push({ label: p.name, reason: 'already imported by an earlier run' });
        continue;
      }
      if (haveSlug.has(p.slug)) {
        result.skipped.push({ label: p.name, reason: `a product already uses the slug "${p.slug}"` });
        continue;
      }
      const filedAs = brand ? (legacyFiling(brand) ?? brand) : undefined;
      result.createdProducts += 1;
      haveSlug.add(p.slug);
      if (dryRun) {
        if (p.wpId) productIdByWpId.set(p.wpId, `dry-run:${p.wpId}`);
        continue;
      }
      try {
        const created = await LocalDB.createProduct({
          name: p.name.slice(0, 200),
          slug: p.slug,
          ...(p.sku ? { sku: p.sku } : {}),
          // Product copy came out of a shop full of page-builder shortcodes and
          // dead plugin embeds. Sanitized like every other write.
          ...(p.description ? { description: sanitizeHtml(p.description) } : {}),
          ...(p.shortDescription ? { short_description: sanitizeHtml(p.shortDescription) } : {}),
          price_cents: p.priceCents,
          ...(p.regularPriceCents !== undefined ? { regular_price_cents: p.regularPriceCents } : {}),
          sale_price_cents: p.salePriceCents,
          on_sale: p.onSale,
          stock: p.stock,
          in_stock: p.inStock,
          categories: p.categorySlugs,
          // The NAME, as the shop spells it — never a slug (see woo.ts) —
          // unless an earlier run already keeps this maker under its old slug.
          ...(filedAs ? { brand: filedAs } : {}),
          // Images are recorded as the dump's relative paths; the CLI's
          // --media <dir> step (import-woocommerce.mjs) ingests the files from
          // the extracted uploads folder and rewrites these to /uploads URLs.
          // Through the shared normaliser so an imported gallery is classified
          // the same way a hand-uploaded one is — a Woo catalogue containing an
          // .mp4 must not arrive without a kind.
          images: normalizeImages(p.imagePaths.map((rel) => ({ src: rel }))),
          status: 'active' as const,
          [WOO_ID_FIELD]: p.wpId,
        } as unknown as Omit<Product, 'id' | 'created_at' | 'updated_at'>);
        if (p.createdAt && created?.id) {
          await LocalDB.updateProduct(created.id, { created_at: p.createdAt } as Partial<Product>);
        }
        if (p.wpId) productIdByWpId.set(p.wpId, created.id);
      } catch (err) {
        result.createdProducts -= 1;
        result.failed.push({ label: p.name, reason: (err as Error).message });
      }
    }
  }

  /* ---- customers ---- */
  const customerIdByWpId = new Map<string, string>();
  {
    const existing = (await LocalDB.getCustomers()) as (Customer & { wp_id?: string })[];
    const byEmail = new Map(existing.map((c) => [c.email.toLowerCase(), c.id]));
    for (const c of existing) {
      const stamp = c[WOO_ID_FIELD];
      if (typeof stamp === 'string' && stamp) customerIdByWpId.set(stamp, c.id);
    }

    for (const c of plan.customers) {
      step(c.email);
      // The stamp FIRST, like products and posts: matching only on email meant
      // that after the operator corrected an imported customer's address, a
      // re-run created a duplicate under the old one.
      if (c.wpId && customerIdByWpId.has(c.wpId)) {
        result.skipped.push({ label: c.email, reason: 'already imported by an earlier run' });
        continue;
      }
      const known = byEmail.get(c.email);
      if (known) {
        // Not a failure: the shop owner's own account, or a second run. The id
        // is still recorded so this import's orders attach to the right person.
        if (c.wpId) customerIdByWpId.set(c.wpId, known);
        result.skipped.push({ label: c.email, reason: 'a customer with that email is already here' });
        continue;
      }
      result.createdCustomers += 1;
      if (dryRun) {
        if (c.wpId) customerIdByWpId.set(c.wpId, `dry-run:${c.wpId}`);
        continue;
      }
      try {
        const created = await LocalDB.createCustomer({
          email: c.email,
          ...(c.name ? { name: c.name } : {}),
          ...(c.phone ? { phone: c.phone } : {}),
          ...(c.address ? { address: c.address } : {}),
          ...(c.city ? { city: c.city } : {}),
          ...(c.postcode ? { postcode: c.postcode } : {}),
          ...(c.country ? { country: c.country } : {}),
          [WOO_ID_FIELD]: c.wpId,
        } as unknown as Omit<Customer, 'id' | 'created_at' | 'updated_at'>);
        if (c.createdAt && created?.id) {
          await LocalDB.updateCustomer(created.id, { created_at: c.createdAt } as Partial<Customer>);
        }
        byEmail.set(c.email, created.id);
        if (c.wpId) customerIdByWpId.set(c.wpId, created.id);
      } catch (err) {
        result.createdCustomers -= 1;
        result.failed.push({ label: c.email, reason: (err as Error).message });
      }
    }
  }

  /* ---- orders ---- */
  {
    const existing = (await LocalDB.getOrders()) as Order[];
    const haveNumber = new Set(existing.map((o) => o.number));
    for (const o of plan.orders) {
      step(o.number);
      if (haveNumber.has(o.number)) {
        // Honest about BOTH ways this happens: identity is WC-<wp_id>, so a
        // second site's dump reusing an id lands here too and must not be
        // silently blessed as "an earlier run".
        result.skipped.push({
          label: o.number,
          reason: 'an order with this number already exists — an earlier run of this dump, or another dump reusing the same wp_id',
        });
        continue;
      }
      result.createdOrders += 1;
      haveNumber.add(o.number);
      if (dryRun) continue;
      try {
        const customerId = o.customerWpId ? customerIdByWpId.get(o.customerWpId) : undefined;
        const createdOrder = await LocalDB.createOrder({
          number: o.number,
          status: o.status,
          currency: o.currency,
          total_cents: o.totalCents,
          // Only a REAL id. A dry-run placeholder must never reach a record.
          ...(customerId && !customerId.startsWith('dry-run:') ? { customer_id: customerId } : {}),
          email: o.email,
          ...(o.name ? { name: o.name } : {}),
          ...(o.phone ? { phone: o.phone } : {}),
          ...(o.address ? { address: o.address } : {}),
          items: o.items.map((i) => {
            const pid = i.productWpId ? productIdByWpId.get(i.productWpId) : undefined;
            return {
              // A line whose product was skipped keeps its NAME and its money.
              // Dropping the line would change the order's history; pointing it
              // at nothing would be a dangling reference.
              ...(pid && !pid.startsWith('dry-run:') ? { product_id: pid } : {}),
              name: i.name,
              qty: i.qty,
              total_cents: i.totalCents,
            };
          }),
        } as unknown as Omit<Order, 'id' | 'created_at' | 'updated_at'>);
        // Every driver's create() stamps created_at with NOW — spread first,
        // then overwrite — so the dump's historical date has to be written in
        // a second pass through update, which merges. Losing it would make a
        // 2019 order look placed today, in the books and in the admin.
        if (o.createdAt && createdOrder?.id) {
          await LocalDB.updateOrder(createdOrder.id, { created_at: o.createdAt } as Partial<Order>);
        }
      } catch (err) {
        result.createdOrders -= 1;
        result.failed.push({ label: o.number, reason: (err as Error).message });
      }
    }
  }

  /* ---- blog posts ---- */
  if (includePosts) {
    const existing = (await LocalDB.getPosts()) as (Post & { wp_id?: string })[];
    const haveSlug = new Set(existing.map((p) => p.slug));
    const haveStamp = new Set(
      existing.map((p) => p[WOO_ID_FIELD]).filter((v): v is string => typeof v === 'string' && !!v),
    );
    for (const p of plan.posts) {
      step(p.title);
      if (p.wpId && haveStamp.has(p.wpId)) {
        result.skipped.push({ label: p.title, reason: 'already imported by an earlier run' });
        continue;
      }
      if (haveSlug.has(p.slug)) {
        result.skipped.push({ label: p.title, reason: `a post already uses the slug "${p.slug}"` });
        continue;
      }
      result.createdPosts += 1;
      haveSlug.add(p.slug);
      if (dryRun) continue;
      try {
        await LocalDB.createPost({
          title: p.title.slice(0, 200),
          slug: p.slug,
          content: sanitizeHtml(p.content),
          ...(p.excerpt ? { excerpt: p.excerpt.slice(0, 600) } : {}),
          // The plan carries the dump's own status. Hard-coding 'published'
          // here put a shop's private drafts on the open web.
          status: p.status,
          author_id: authorId,
          tags: [],
          ...(p.createdAt ? { publish_date: p.createdAt } : {}),
          views: 0,
          [WOO_ID_FIELD]: p.wpId,
        } as unknown as Omit<Post, 'id' | 'created_at' | 'updated_at'>);
        if (p.wpId) haveStamp.add(p.wpId);
      } catch (err) {
        result.createdPosts -= 1;
        result.failed.push({ label: p.title, reason: (err as Error).message });
      }
    }
  }

  // Last, and only if something shop-shaped actually landed: an import that
  // created nothing is not evidence that this install is a shop.
  if (!dryRun && (result.createdProducts > 0 || result.createdOrders > 0)) {
    result.enabledCommerce = await maybeEnableCommerce();
  }

  return result;
}
