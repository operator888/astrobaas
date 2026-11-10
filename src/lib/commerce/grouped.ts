/**
 * Grouped products: one page that shows 2–10 related products together.
 *
 * Pure — no I/O — so the rules are testable without a database. The service
 * (`commerce-service.ts`) loads the members and calls in here; the routes call
 * in here to shape what they return.
 *
 * ## What a group is, and what it is not
 *
 * A group is a product whose `type` is `grouped` and whose
 * `grouped_product_ids` lists, in order, the products it shows. Each member
 * stays an ordinary product with its own SKU, price and stock, and is bought on
 * its OWN cart line. The group itself is never a cart line: `resolvePurchasable`
 * refuses it, so the cart, quote and order code needs no notion of a group.
 *
 * It is NOT a bundle (a composite sold at one price, `core/bundle-products`).
 * A group has no price and no stock of its own. What a shopper sees as its
 * price — "from €30" — and its availability are DERIVED ON READ from the
 * members as they are now (recurring-bug-patterns, 7): a member's sale ending
 * or selling out changes the group's answer on the next request without
 * anything rewriting the group.
 *
 * ## Membership rules (enforced on every write, by saveProduct)
 *
 * - between `GROUP_LIMITS.min` and `GROUP_LIMITS.max` members;
 * - no duplicates, and not itself;
 * - every member exists, and none is itself a group (no nesting);
 * - no member that has variants: a group page has a quantity box per member,
 *   and a product with variants cannot be bought without choosing one. A member
 *   that GAINS variants after joining is kept (refusing the member's save would
 *   make the group a lock on another product) and is shown as "choose options".
 */

import type {
  GroupedProductMember, Product, ProductImage, StockStatusInfo,
} from '../../core/models';
import { mainImage } from '../product-fields';
import { isVariable, priceRange } from './variants';
import { effectiveThreshold, groupStockStatus, productStockStatus } from './stock-status';

/**
 * The plan's limits. The plan names "2–5 related products" as the typical
 * case and "up to 10" as the composition limit; 10 is the hard cap, and fewer
 * than 2 is not a group.
 */
export const GROUP_LIMITS = { min: 2, max: 10 } as const;

/** The same id shape `normalizeLinkedIds` accepts for upsells. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isGrouped(p: { type?: string } | null | undefined): boolean {
  return p?.type === 'grouped';
}

/**
 * Whether a shopper may see this member on a group page: the same two rules a
 * product page applies — active, and not hidden from the catalogue. A `search`
 * or `catalog` visibility only decides which LISTING shows a product; it is
 * still a product with a page, so it is shown here.
 */
export function isPublicMember(p: Pick<Product, 'status' | 'catalog_visibility'>): boolean {
  return p.status === 'active' && (p.catalog_visibility ?? 'visible') !== 'hidden';
}

export type GroupRejectionCode =
  | 'group.member_ids_invalid'
  | 'group.too_few_members'
  | 'group.too_many_members'
  | 'group.duplicate_member'
  | 'group.self_member'
  | 'group.unknown_member'
  | 'group.nested_group'
  | 'group.variable_member';

export type GroupValidation =
  | { ok: true; ids: string[] }
  | { ok: false; code: GroupRejectionCode; message: string };

type MemberLookup = (id: string) => Pick<Product, 'id' | 'name' | 'type' | 'variants'> | null | undefined;

/**
 * Validate a group's member list. Refuses rather than repairs: a duplicate or
 * an unknown id is an operator's mistake, and quietly dropping it would save a
 * group that is not the one they asked for.
 *
 * `previous` is the list as stored. A member already in it is not re-judged on
 * its TYPE — a member that gained variants after joining stays — but it must
 * still exist and must not have become a group.
 *
 * `cascade` lets the list shrink below the minimum. Only membership upkeep
 * (a member was deleted) passes it: refusing that save would leave the deleted
 * id in the group, and a group of one is still a page a shopper can use.
 */
export function validateGroupMembers(
  raw: unknown,
  ctx: { selfId?: string; lookup: MemberLookup; previous?: readonly string[]; cascade?: boolean },
): GroupValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'group.member_ids_invalid', message: 'grouped_product_ids must be a list of product ids' };
  }
  const ids: string[] = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (!ID.test(id)) {
      return { ok: false, code: 'group.member_ids_invalid', message: `Not a product id: ${JSON.stringify(v)}` };
    }
    if (ids.includes(id)) {
      return { ok: false, code: 'group.duplicate_member', message: `Product ${id} is in the group twice` };
    }
    if (ctx.selfId && id === ctx.selfId) {
      return { ok: false, code: 'group.self_member', message: 'A grouped product cannot contain itself' };
    }
    ids.push(id);
  }
  if (ids.length > GROUP_LIMITS.max) {
    return { ok: false, code: 'group.too_many_members', message: `A group holds at most ${GROUP_LIMITS.max} products` };
  }
  if (ids.length < GROUP_LIMITS.min && !ctx.cascade) {
    return { ok: false, code: 'group.too_few_members', message: `A group needs at least ${GROUP_LIMITS.min} products` };
  }
  const previous = new Set(ctx.previous ?? []);
  for (const id of ids) {
    const member = ctx.lookup(id);
    if (!member) {
      return { ok: false, code: 'group.unknown_member', message: `No product with id ${id}` };
    }
    if (isGrouped(member)) {
      return { ok: false, code: 'group.nested_group', message: `"${member.name}" is itself a grouped product; groups cannot contain groups` };
    }
    if (!previous.has(id) && isVariable(member)) {
      return {
        ok: false, code: 'group.variable_member',
        message: `"${member.name}" has variants; a group can only hold products bought without choosing an option`,
      };
    }
  }
  return { ok: true, ids };
}

/** One member, as a group page needs it. */
export function memberView(
  m: Product,
  defaultThreshold: number,
): GroupedProductMember {
  const variable = isVariable(m);
  const range = variable ? priceRange(m) : null;
  const img: ProductImage | undefined = mainImage(m.images);
  return {
    id: m.id,
    name: m.name,
    slug: m.slug,
    ...(m.sku ? { sku: m.sku } : {}),
    type: variable ? 'variable' : 'simple',
    price_cents: range ? range.min : m.price_cents,
    regular_price_cents: range ? range.min : (m.regular_price_cents ?? m.price_cents),
    on_sale: range ? false : m.on_sale === true,
    stock_status: productStockStatus(m, defaultThreshold),
    image: img ? { src: img.src, ...(img.alt ? { alt: img.alt } : {}) } : null,
    status: m.status,
    catalog_visibility: m.catalog_visibility ?? 'visible',
  };
}

export interface GroupReadOptions {
  /** Anonymous readers see only public members; staff see every member. */
  publicOnly: boolean;
  /** The shop-wide low-stock level (`resolveLowStockThreshold`). */
  defaultThreshold: number;
  /** Per-locale projection, applied to each member before it is shaped. */
  project?: (p: Product) => Product;
}

export interface GroupView {
  ids: string[];
  members: GroupedProductMember[];
  price_from_cents: number | null;
  stock_status: StockStatusInfo;
}

/**
 * The group as a reader sees it, from its stored ids and a member lookup.
 *
 * The price and the availability are judged on the PUBLIC members for every
 * reader, staff included, so the admin shows the same "from" price and badge a
 * shopper gets; staff merely see the hidden and draft members listed too.
 * A missing member (deleted between the group's write and this read) is
 * skipped, never reported as an error.
 */
export function readGroup(
  group: Pick<Product, 'grouped_product_ids' | 'low_stock_threshold'>,
  lookup: (id: string) => Product | null | undefined,
  opts: GroupReadOptions,
): GroupView {
  const all: GroupedProductMember[] = [];
  const shown: GroupedProductMember[] = [];
  for (const id of group.grouped_product_ids ?? []) {
    const stored = lookup(id);
    if (!stored || isGrouped(stored)) continue;
    const view = memberView(opts.project ? opts.project(stored) : stored, opts.defaultThreshold);
    all.push(view);
    if (isPublicMember(stored)) shown.push(view);
  }
  const members = opts.publicOnly ? shown : all;
  const prices = shown.map((m) => m.price_cents).filter((n) => Number.isFinite(n));
  return {
    ids: members.map((m) => m.id),
    members,
    price_from_cents: prices.length ? Math.min(...prices) : null,
    stock_status: groupStockStatus(
      shown.map((m) => m.stock_status),
      effectiveThreshold(group, opts.defaultThreshold),
    ),
  };
}

/**
 * A product with its group fields derived. Not a group: returned unchanged.
 *
 * Builds a NEW object; the input (which may be a live cached row) is never
 * written. On a group:
 *
 * - `grouped_products` — the members, resolved and in order;
 * - `grouped_product_ids` — narrowed to the members this reader may see, so a
 *   public read does not publish the id of a hidden or draft product;
 * - `price_from_cents`, and `price_cents`/`regular_price_cents` set to it, so a
 *   listing or a client that knows nothing of groups shows "€30", not "€0";
 *   `on_sale` false and no sale price, because a group has no sale of its own;
 * - `stock_status` from the members (groupStockStatus).
 */
export function withGroup<T extends Product>(
  product: T,
  lookup: (id: string) => Product | null | undefined,
  opts: GroupReadOptions,
): T {
  if (!isGrouped(product)) return product;
  const g = readGroup(product, lookup, opts);
  const from = g.price_from_cents ?? 0;
  return {
    ...product,
    grouped_product_ids: g.ids,
    grouped_products: g.members,
    price_from_cents: g.price_from_cents,
    price_cents: from,
    regular_price_cents: from,
    sale_price_cents: null,
    on_sale: false,
    stock_status: g.stock_status,
  };
}

/** Every member id named by any group in a list, once each. */
export function memberIdsOf(products: readonly Pick<Product, 'type' | 'grouped_product_ids'>[]): string[] {
  const out = new Set<string>();
  for (const p of products) {
    if (!isGrouped(p)) continue;
    for (const id of p.grouped_product_ids ?? []) out.add(id);
  }
  return [...out];
}

/** The groups that list a product, for membership upkeep and the "is a member" rule. */
export function groupsContaining<T extends Pick<Product, 'id' | 'type' | 'grouped_product_ids'>>(
  products: readonly T[],
  memberId: string,
): T[] {
  return products.filter((p) => isGrouped(p) && (p.grouped_product_ids ?? []).includes(memberId));
}

/**
 * A whole catalogue with each group's `price_cents` set to its "from" price,
 * judged against the same list. For readers that already hold every product
 * (search suggestions) and show a price but nothing else of a group.
 */
export function withGroupPrices<T extends Product>(products: readonly T[]): T[] {
  if (!products.some((p) => isGrouped(p))) return products as T[];
  const byId = new Map<string, Product>(products.map((p) => [p.id, p]));
  return products.map((p) => (isGrouped(p)
    ? { ...p, price_cents: readGroup(p, (k) => byId.get(k), { publicOnly: true, defaultThreshold: 0 }).price_from_cents ?? 0 }
    : p));
}
