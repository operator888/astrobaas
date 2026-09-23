/**
 * The admin navigation, as data.
 *
 * ## Why this is a list and not seventeen blocks of markup
 *
 * It used to be seventeen hand-copied `<a>` blocks in AdminSidebar.astro.
 * Adding a screen meant copying one and editing it, and the last person to do
 * that shipped `Redirects` as a bare English string while every other label went
 * through `t()` — invisible until a Greek shop opened the menu.
 *
 * As a list, three things become true by construction rather than by somebody
 * remembering: a new screen is one entry, its label MUST be a translation key,
 * and a group that a role cannot see anything in cannot render an empty
 * heading. `tests/admin-nav.test.mjs` enforces all three.
 *
 * ## Grouped by what a person is trying to do
 *
 * Seventeen flat links in one column is a list you read every time rather than
 * a place you learn. The groups are intents, not technical categories: a shop
 * owner opening this in the morning is going to Orders, and somebody writing is
 * going to Posts, and neither is thinking about whether a webhook is "content"
 * or "system".
 *
 * Shop comes first because these installs are shops. System is last: it is the
 * drawer you open twice a year.
 */

import { canOpenAdminPage } from './admin-access';
import { getContentTypes } from '../core/content-types';
import type { Role } from '../core/models';

export interface NavItem {
  href: string;
  /** Suffix of the `admin.chrome.*` translation key. Never a literal label. */
  key: string;
  /** SVG path `d` attributes, drawn in a 24x24 stroked viewBox. */
  paths: string[];
}

export interface NavGroup {
  /**
   * Suffix of the `admin.chrome.*` key for the heading, or null for the
   * ungrouped items at the top.
   */
  heading: string | null;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    heading: null,
    items: [
      { href: "/admin", key: "dashboard", paths: ["M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2z", "M8 5a2 2 0 012-2h2a2 2 0 012 2v0H8v0z"] },
    ],
  },
  {
    heading: "groupShop",
    items: [
      { href: "/admin/products", key: "products", paths: ["M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"] },
      { href: "/admin/orders", key: "orders", paths: ["M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"] },
      { href: "/admin/customers", key: "customers", paths: ["M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"] },
    ],
  },
  {
    heading: "groupContent",
    items: [
      { href: "/admin/posts", key: "posts", paths: ["M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"] },
      { href: "/admin/categories", key: "categories", paths: ["M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"] },
      { href: "/admin/media", key: "media", paths: ["M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"] },
      { href: "/admin/messages", key: "messages", paths: ["M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"] },
      { href: "/admin/translations", key: "translations", paths: ["M3 5h12", "M9 3v2c0 4.4-2.7 8.3-6 9.7", "M6 9c0 3.3 2.6 6.2 6 7", "M13 20l4-9 4 9", "M14.5 17h5"] },
      { href: "/admin/import", key: "importSite", paths: ["M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2", "M7 10l5 5 5-5", "M12 15V3"] },
      { href: "/admin/content-types", key: "contentTypes", paths: ["M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"] },
    ],
  },
  {
    heading: "groupSite",
    items: [
      { href: "/admin/themes", key: "themes", paths: ["M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zM21 5a2 2 0 00-2-2h-4a2 2 0 00-2 2v12a4 4 0 004 4h4a2 2 0 002-2V5z"] },
      { href: "/admin/insights", key: "insights", paths: ["M4 19h16", "M7 16V9", "M12 16V5", "M17 16v-4"] },
      { href: "/admin/redirects", key: "redirects", paths: ["M13 5l7 7-7 7M4 12h16"] },
      { href: "/admin/legal", key: "legalPages", paths: ["M12 3l7 4v5c0 4.5-3 8.6-7 9.7C8 20.6 5 16.5 5 12V7l7-4z", "M9 12l2 2 4-4"] },
    ],
  },
  {
    heading: "groupSystem",
    items: [
      { href: "/admin/users", key: "users", paths: ["M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z"] },
      { href: "/admin/plugins", key: "plugins", paths: ["M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a1 1 0 01-1-1V9a1 1 0 011-1h1a2 2 0 100-4H4a1 1 0 01-1-1V4a1 1 0 011-1h3a1 1 0 001-1v-1a2 2 0 012-2z"] },
      { href: "/admin/api-keys", key: "apiKeys", paths: ["M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"] },
      { href: "/admin/webhooks", key: "webhooks", paths: ["M13 10V3L4 14h7v7l9-11h-7z"] },
      { href: "/admin/operations", key: "backgroundJobs", paths: ["M12 8v4l3 3", "M12 3a9 9 0 100 18 9 9 0 000-18z"] },
      { href: "/admin/email-templates", key: "emailWording", paths: ["M3 8l9 6 9-6", "M3 6h18v12H3z"] },
      { href: "/admin/privacy", key: "dataRequests", paths: ["M12 3l7 4v5c0 4.5-3 8.6-7 9.7C8 20.6 5 16.5 5 12V7l7-4z", "M9.5 12.5h5", "M12 10v5"] },
      { href: "/admin/audit", key: "audit", paths: ["M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"] },
      { href: "/admin/tools", key: "tools", paths: ["M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM10 12a2 2 0 104 0 2 2 0 00-4 0z"] },
      { href: "/admin/settings", key: "settings", paths: ["M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z", "M15 12a3 3 0 11-6 0 3 3 0 016 0z"] },
    ],
  },
];

/**
 * The groups this role can actually see.
 *
 * Items are filtered first, THEN empty groups are dropped. A heading with
 * nothing under it is worse than no heading: it tells someone a section exists
 * and then refuses to show it.
 */
export function navFor(role: Role | undefined): NavGroup[] {
  return NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => canOpenAdminPage(i.href, role)) }))
    .filter((g) => g.items.length > 0);
}

/**
 * One nav entry per registered custom content type — the guarantee that no
 * collection exists without a door to it.
 *
 * NOT part of `NAV`, deliberately: NAV items carry translation KEYS and are
 * asserted complete in three locales by tests/admin-nav.test.mjs, while a
 * content type carries its own human label (`labelPlural`) exactly like a
 * plugin admin page does. Same pattern, same rendering rule: composed at
 * request time, labelled by the thing itself.
 *
 * Called at RENDER time on purpose — the registry is an in-process map that
 * plugin bootstrap rebuilds per request cycle; reading it at import time
 * would capture it empty. Filtering goes through the same `canOpenAdminPage`
 * rule the middleware enforces for `/admin/content/...`, so a link is never
 * shown to someone who would be bounced for clicking it.
 */
export function contentTypeNavFor(role: Role | undefined): { href: string; label: string }[] {
  if (!canOpenAdminPage('/admin/content', role)) return [];
  return getContentTypes()
    .map((def) => ({
      href: `/admin/content/${encodeURIComponent(def.name)}`,
      label: def.labelPlural || `${def.label}s`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Longest-prefix match for the active link, with `/admin` matched EXACTLY.
 *
 * `/admin` is a prefix of every other admin path, so a plain `startsWith` would
 * light up Dashboard on every screen in the product.
 */
export function isActiveNav(href: string, pathname: string): boolean {
  if (href === '/admin') return pathname === '/admin' || pathname === '/admin/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
