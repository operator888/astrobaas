/**
 * Who may open which admin screen — decided once, consulted everywhere.
 *
 * ## Why this module exists
 *
 * Before it, admin access was expressed three separate times: a regex of
 * admin-only prefixes in the middleware, a hand-written `role !== 'admin'`
 * check at the top of most pages, and nothing at all in the sidebar — which
 * rendered all thirteen links to everyone, so a restricted user clicked
 * "Users", got bounced to the dashboard, and learned nothing except that the
 * product was broken.
 *
 * Three expressions of one rule is how they drift. This codebase has that
 * failure repeatedly: a rule fixed in one place and missed in its siblings.
 * So the map below is the rule, and the middleware, the sidebar and the page
 * guards all ask it.
 *
 * ## The middleware is still the enforcement point
 *
 * Hiding a link is presentation, not security. `canOpenAdminPage` is what the
 * middleware calls, and it denies by prefix so a screen added later is covered
 * even if its author forgets a frontmatter check. The sidebar calls the same
 * function purely so the menu matches what the user can actually reach.
 *
 * API routes are NOT governed here. They gate on the capability predicates in
 * `lib/auth.ts` (`canManageCatalog`, `canReadCommerce`, …) because an endpoint's
 * question is "may this role perform this action", not "may it see this page".
 */
import type { Role } from '../core/models';

/** Every role that can reach the admin area at all. */
const STAFF: readonly Role[] = ['admin', 'editor', 'author', 'manager'];

export interface AdminNavItem {
  /** Exact href for the sidebar link. */
  href: string;
  /** Path prefix this entry governs — everything under it shares the rule. */
  prefix: string;
  label: string;
  /** Roles allowed to open it. */
  roles: readonly Role[];
}

/**
 * The admin surface, in navigation order.
 *
 * `prefix` is what access is keyed on, so `/admin/posts/new` and
 * `/admin/posts/123/edit` inherit `/admin/posts` without needing their own row.
 *
 * A `manager` is shop staff: they run the catalogue and need to see orders and
 * customers to do it, but nothing that changes how the site is built, who can
 * log in, or where money goes.
 */
export const ADMIN_NAV: readonly AdminNavItem[] = [
  { href: '/admin', prefix: '/admin', label: 'Dashboard', roles: STAFF },
  { href: '/admin/posts', prefix: '/admin/posts', label: 'Posts', roles: STAFF },
  { href: '/admin/categories', prefix: '/admin/categories', label: 'Categories', roles: ['admin', 'editor', 'author', 'manager'] },
  { href: '/admin/media', prefix: '/admin/media', label: 'Media', roles: STAFF },
  { href: '/admin/products', prefix: '/admin/products', label: 'Products', roles: ['admin', 'editor', 'manager'] },
  // Read-only for a manager; the API refuses the writes (order status, refunds,
  // customer records) regardless of the page being reachable.
  { href: '/admin/orders', prefix: '/admin/orders', label: 'Orders', roles: ['admin', 'manager'] },
  { href: '/admin/customers', prefix: '/admin/customers', label: 'Customers', roles: ['admin', 'manager'] },
  { href: '/admin/messages', prefix: '/admin/messages', label: 'Messages', roles: ['admin'] },
  { href: '/admin/themes', prefix: '/admin/themes', label: 'Themes', roles: ['admin'] },
  { href: '/admin/plugins', prefix: '/admin/plugins', label: 'Plugins', roles: ['admin'] },
  { href: '/admin/users', prefix: '/admin/users', label: 'Users', roles: ['admin'] },
  { href: '/admin/api-keys', prefix: '/admin/api-keys', label: 'API Keys', roles: ['admin'] },
  // Same roles as Products: this is catalogue work, and a MANAGER noticing a
  // dead URL is exactly who the screen is for.
  { href: '/admin/redirects', prefix: '/admin/redirects', label: 'Redirects', roles: ['admin', 'editor', 'manager'] },
  // Same three roles as Redirects, and for the same reason: the report's most
  // actionable half is dead URLs that cost money, and a manager watching the
  // catalogue is exactly who should see it. It exposes no personal data —
  // counts, titles and paths only, never a customer or an address.
  { href: '/admin/insights', prefix: '/admin/insights', label: 'Insights', roles: ['admin', 'editor', 'manager'] },
  // The builder ALTERS THE API SURFACE (collections appear, vanish, go
  // public), which is admin work. ENTRIES are content work: the same
  // admin+editor pair the entries API itself enforces — the rule stated once
  // there, mirrored here so the door matches the room.
  { href: '/admin/content-types', prefix: '/admin/content-types', label: 'Content types', roles: ['admin'] },
  { href: '/admin/legal', prefix: '/admin/legal', label: 'Legal pages', roles: ['admin'] },
  // Admin only, and narrower than every other content screen: an import writes
  // site-wide redirects and cannot be undone. Same rule the API enforces
  // (`canImportContent`), stated here so the door matches the room.
  { href: '/admin/import', prefix: '/admin/import', label: 'Import', roles: ['admin'] },
  { href: '/admin/content', prefix: '/admin/content', label: 'Custom content', roles: ['admin', 'editor'] },
  // Anyone who can write content: the person who does the translating is
  // usually an editor or an author, and a backlog only admins can see is a
  // backlog nobody works through.
  { href: '/admin/translations', prefix: '/admin/translations', label: 'Translations', roles: ['admin', 'editor', 'author', 'manager'] },
  { href: '/admin/webhooks', prefix: '/admin/webhooks', label: 'Webhooks', roles: ['admin'] },
  { href: '/admin/audit', prefix: '/admin/audit', label: 'Audit Log', roles: ['admin'] },
  // Admin only, and for the same reason the import is: this screen returns one
  // named person's complete record from an email address alone, and erases it.
  { href: '/admin/privacy', prefix: '/admin/privacy', label: 'Data requests', roles: ['admin'] },
  // Admin only: the email log carries recipient addresses, and the scheduler
  // status describes the server rather than the site.
  { href: '/admin/operations', prefix: '/admin/operations', label: 'Background jobs', roles: ['admin'] },
  // Admin only: these emails carry password resets and sign-in links, so the
  // ability to reword them is the ability to phrase a phishing message in the
  // site's own voice from the site's own address (C-112).
  { href: '/admin/email-templates', prefix: '/admin/email-templates', label: 'Email wording', roles: ['admin'] },
  { href: '/admin/settings', prefix: '/admin/settings', label: 'Settings', roles: ['admin'] },
  { href: '/admin/tools', prefix: '/admin/tools', label: 'Tools', roles: ['admin'] },
];

/**
 * Prefixes with no nav entry but which still need a rule.
 *
 * Without these, a screen reachable only by deep link would fall through to the
 * default and be treated as open to all staff.
 */
const EXTRA_RULES: readonly Pick<AdminNavItem, 'prefix' | 'roles'>[] = [
  // The profile screen is every staff member's own account.
  { prefix: '/admin/profile', roles: STAFF },
];

/**
 * Longest matching prefix wins, so `/admin/posts` does not answer for
 * `/admin/products`.
 *
 * `/admin` itself is matched EXACTLY, never as a prefix. It is a prefix of
 * every admin path, so treating it like the others made the dashboard's rule
 * (all staff) the fallback for any screen without one — which is precisely
 * backwards from the intended "an unknown screen is admin-only". A test caught
 * that; without this branch, a page added later would silently be open to
 * every editor, author and manager.
 */
/**
 * Plugin screens, consulted before the table below.
 *
 * A function rather than rows spliced into ADMIN_NAV, because this table is
 * longest-prefix-wins: a plugin able to insert `/admin/products/bulk` would not
 * merely add a screen, it would out-specify the `/admin/products` rule and
 * decide who may open everything beneath it. Plugin pages live under their own
 * `/admin/plugin/<id>/` prefix, which shares no prefix with any core screen, and
 * they answer only for their own exact href.
 *
 * Injected rather than imported so this module stays pure and testable — and so
 * a cycle (admin-access → plugin registry → …) cannot form.
 */
let pluginRoles: ((pathname: string) => readonly Role[] | undefined) | null = null;

export function setPluginAdminRoleResolver(
  fn: ((pathname: string) => readonly Role[] | undefined) | null,
): void {
  pluginRoles = fn;
}

function ruleFor(pathname: string): readonly Role[] | undefined {
  const fromPlugin = pluginRoles?.(pathname);
  if (fromPlugin) return fromPlugin;
  let best: { len: number; roles: readonly Role[] } | undefined;
  for (const { prefix, roles } of [...ADMIN_NAV, ...EXTRA_RULES]) {
    const matches = prefix === '/admin'
      ? pathname === '/admin'
      : pathname === prefix || pathname.startsWith(`${prefix}/`);
    if (matches && (!best || prefix.length > best.len)) {
      best = { len: prefix.length, roles };
    }
  }
  return best?.roles;
}

/**
 * May this role open this admin path?
 *
 * Unknown paths under `/admin` DENY to everything but admin. A new screen is
 * therefore admin-only until someone deliberately adds a rule — the safe
 * direction, and the one that makes forgetting visible rather than silent.
 *
 * A plugin screen inherits exactly that: `/admin/plugin/<id>/<page>` is an
 * unknown path until the plugin declares roles for it, so a plugin that forgets
 * is admin-only rather than open.
 */
export function canOpenAdminPage(pathname: string, role: Role | undefined): boolean {
  if (!role) return false;
  const roles = ruleFor(pathname);
  if (!roles) return role === 'admin';
  return roles.includes(role);
}

/** The nav entries this role should actually see. */
export function navFor(role: Role | undefined): AdminNavItem[] {
  if (!role) return [];
  return ADMIN_NAV.filter((item) => item.roles.includes(role));
}

/** Convenience for a page's own frontmatter guard. */
export const canOpen = (href: string, role: Role | undefined): boolean =>
  canOpenAdminPage(href, role);
