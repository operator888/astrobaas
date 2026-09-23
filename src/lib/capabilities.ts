/**
 * What each role may do (C-138) — one table, and the predicates read from it.
 *
 * ## What this row is, and what it deliberately is not
 *
 * It is **per-capability editing of the five built-in roles**, which is what
 * the WordPress plugin this row cites is actually used for.
 *
 * It is NOT arbitrary role names, and shipping those would be dishonest.
 * A custom role is not a row in a table here: it is a value that has to satisfy
 * dozens of `role === 'admin'`-style comparisons scattered through routes,
 * every one of which silently answers "no" for a name it has never heard. The
 * result is a role that can sign in and do nothing, with no message anywhere
 * explaining why. Adding names is a different, larger piece of work.
 *
 * ## Extraction first, overrides second
 *
 * The grants below encode today's behaviour EXACTLY. The predicates in
 * `auth.ts` and `visibility.ts` now delegate here, and a test pins every
 * role×capability answer against the old hard-coded ones — so the extraction is
 * provably behaviour-neutral before any override mechanism exists. Doing it the
 * other way round means a change in permissions arrives mixed with a change in
 * how permissions are computed, and nobody can tell which one broke something.
 *
 * ## An unset override is not a deny
 *
 * The stored table holds only the differences an operator made. A capability
 * with no entry falls back to the built-in grant — otherwise every capability
 * added after an operator saved their overrides would arrive switched off for
 * them, silently, on upgrade.
 */
import type { Role } from '../core/models';

/**
 * The things a role can be granted.
 *
 * Named after what a person does, not after a route. A capability that maps to
 * one endpoint would have to be renamed every time the endpoint moves, and an
 * operator reading the matrix would be choosing between URLs.
 */
export const CAPABILITIES = [
  'author_posts',
  'manage_all_posts',
  'import_content',
  'manage_catalog',
  'delete_products',
  'read_commerce',
  'write_commerce',
  /**
   * Override the tax the engine computed on an order.
   *
   * Its OWN capability rather than a corner of `write_commerce`, because the
   * owner asked for "managers and admins" and `manager` deliberately does not
   * have `write_commerce` — which also gates refunds and status changes.
   * Granting those to reach a tax override would widen power over money that
   * nobody asked to widen. One narrow capability says exactly what it permits,
   * and an operator can revoke it on the roles screen without losing anything
   * else.
   */
  'override_tax',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** A sentence per capability, for the admin matrix. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  author_posts: 'Write posts and upload media',
  manage_all_posts: 'Edit and delete anybody\'s posts',
  import_content: 'Run a content import',
  manage_catalog: 'Create and edit products',
  override_tax: 'Override the VAT on an order, with a recorded reason',
  delete_products: 'Delete products',
  read_commerce: 'See orders and customers',
  write_commerce: 'Change orders and customer records',
};

/**
 * Today's grants, exactly.
 *
 * Every entry here was read off the predicate it replaces. Two are worth their
 * comments because they are deliberately not what you would guess:
 *
 *  - `import_content` is ADMIN ONLY and narrower than every other content
 *    capability. An import writes site-wide redirects that change what every
 *    old URL resolves to, creates categories, and fetches files from a
 *    third-party host on the server's behalf. It is also not undoable — an
 *    editor can fix a bad post in a minute; nobody can un-import a site.
 *  - `delete_products` excludes EDITOR while `manage_catalog` includes them.
 *    Deleting a product is destructive in a way editing is not, and this was
 *    admin-only before managers existed; widening it to editors while
 *    extracting this table would be a policy change nobody asked for.
 */
const BUILTIN: Record<Role, readonly Capability[]> = {
  admin: [...CAPABILITIES],
  editor: ['author_posts', 'manage_all_posts', 'manage_catalog', 'read_commerce', 'write_commerce', 'override_tax'],
  author: ['author_posts'],
  // `override_tax` and not `write_commerce`: a shop manager settles a VAT
  // question at the counter, which is the case the owner asked for. Refunds and
  // status changes stay where they were.
  manager: ['author_posts', 'manage_catalog', 'delete_products', 'read_commerce', 'override_tax'],
  viewer: [],
};

/** The roles an operator may edit. New NAMES are out of scope — see the header. */
export const EDITABLE_ROLES: readonly Role[] = ['editor', 'author', 'manager', 'viewer'];

/** Every role, including the one that cannot be edited. */
export const ALL_ROLES: readonly Role[] = ['admin', 'editor', 'author', 'manager', 'viewer'];

/** The setting the operator's differences live in. */
export const ROLE_OVERRIDES_SETTING = 'role_capability_overrides';

/** `{ editor: { delete_products: true } }` — only the differences. */
export type RoleOverrides = Partial<Record<Role, Partial<Record<Capability, boolean>>>>;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ALL_ROLES as readonly string[]).includes(value);
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/** The built-in grants for a role, before any override. */
export function builtinCapabilities(role: string | undefined): readonly Capability[] {
  return isRole(role) ? BUILTIN[role] : [];
}

/**
 * May this role do this thing?
 *
 * ADMIN IS NOT REDUCIBLE. An operator who switched off their own last
 * capability would be locked out of the screen that switches it back on, and
 * there is no CLI verb to repair it — so the override table is simply not
 * consulted for `admin`. That is a decision, not an oversight, and the admin
 * screen says so rather than offering checkboxes that quietly do nothing.
 */
export function hasCapability(
  role: string | undefined,
  cap: Capability,
  overrides?: RoleOverrides | null,
): boolean {
  if (!isRole(role)) return false;
  if (role === 'admin') return BUILTIN.admin.includes(cap);
  const override = overrides?.[role]?.[cap];
  // Only a real boolean overrides. `undefined` means "the operator said nothing
  // about this", which must fall back rather than deny — otherwise every
  // capability added in a later release arrives switched off for anyone who had
  // ever saved this table.
  if (typeof override === 'boolean') return override;
  return BUILTIN[role].includes(cap);
}

/** The effective list for a role, for the admin matrix and `/api/auth/me`. */
export function effectiveCapabilities(
  role: string | undefined,
  overrides?: RoleOverrides | null,
): Capability[] {
  return CAPABILITIES.filter((c) => hasCapability(role, c, overrides));
}

/**
 * Rebuild a stored override table, dropping anything unrecognised.
 *
 * The same discipline the content-type definitions get: the stored value
 * outlives the screen that wrote it, so it can arrive through the settings API,
 * a restore or a hand edit. An unknown role or capability is DROPPED rather
 * than refused — a table that fails to load because a later release renamed one
 * capability would take every other override down with it.
 *
 * `admin` is dropped too, so a hand-edited table cannot express something the
 * resolver will then ignore.
 */
export function normaliseOverrides(raw: unknown): RoleOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: RoleOverrides = {};
  for (const [role, caps] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRole(role) || role === 'admin') continue;
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) continue;
    const kept: Partial<Record<Capability, boolean>> = {};
    for (const [cap, value] of Object.entries(caps as Record<string, unknown>)) {
      if (!isCapability(cap) || typeof value !== 'boolean') continue;
      // Storing a value equal to the built-in grant is noise: it makes the
      // table grow with entries that change nothing and hides the ones that do.
      if (value === BUILTIN[role].includes(cap)) continue;
      kept[cap] = value;
    }
    if (Object.keys(kept).length > 0) out[role] = kept;
  }
  return out;
}
