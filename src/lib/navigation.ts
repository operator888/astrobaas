/**
 * The site's navigation menu — what an operator edits at /admin/navigation.
 *
 * ## The gap this closes
 *
 * `HeaderProps` carried a site title, a locale and the language switcher, and
 * nothing else. Every bundled theme built its own four links — Home, Blog,
 * About, Contact — inside its Header component, so the answer to "how do I add
 * Shop to the menu?" was "edit the theme and redeploy". That is the first
 * question anyone evaluating a CMS asks, and it contradicted the project's own
 * pitch that publishing is a write, not a deploy.
 *
 * ## One setting, validated on every path in
 *
 * The menu is stored as the `navigation` setting and written through the
 * ordinary settings endpoint, which calls `validateNavigation` for this key
 * (settings-validate.ts) and stores `normaliseNavigation`'s output. So there is
 * exactly one shape on disk, and no second write route that could forget a rule.
 *
 * ## Why a link is checked, not trusted
 *
 * Whatever is saved here is rendered as `<a href>` on every public page. A
 * `javascript:` URL in a menu is a stored XSS on the whole site, so hrefs are an
 * allow-list of shapes rather than a denylist of schemes: a root-relative path,
 * a same-page anchor, an http(s) address, or mailto:/tel:. Anything else is
 * refused with the reason, and an operator who typed `about` is told to write
 * `/about`.
 *
 * ## Absent means "the theme's own links"
 *
 * A site that has never saved a menu keeps exactly the header it has today.
 * `resolveNavigation` returns an empty list for that case and every theme falls
 * back to its built-in links — so shipping this changes nothing for anybody
 * until they choose to change it.
 */
import { splitLocaleFromPath, localePath } from './i18n';

/** The settings key the menu lives under. */
export const NAVIGATION_SETTING = 'navigation';

/**
 * Bounds, with the reason for each.
 *
 * A header has room for a handful of links; these limits are far past that and
 * exist to stop a stored value from becoming a denial of service on every page
 * render, not to design the menu for anybody.
 */
export const NAV_LIMITS = {
  /** Top-level items. A header with thirty links has stopped being a header. */
  items: 30,
  /** Children under one item. */
  children: 12,
  /** Label length, in characters. */
  label: 60,
  /** Href length. Long enough for any real URL with a query string. */
  href: 500,
} as const;

/** One item as stored. */
export interface NavItem {
  /** The text shown, in the site's default language. */
  label: string;
  /** Where it goes: `/path`, `#anchor`, `https://…`, `mailto:…` or `tel:…`. */
  href: string;
  /**
   * Labels in other languages, keyed by language subtag (`el`, `de`). Used
   * when the reader is on that language's pages; the default `label` otherwise.
   */
  labels?: Record<string, string>;
  /** Open in a new tab. Honoured for external links only — see `resolve`. */
  newTab?: boolean;
  /** One level of submenu. A child cannot have children of its own. */
  children?: NavItem[];
}

export interface Navigation {
  items: NavItem[];
}

/** One item ready to render — the shape a theme's Header receives. */
export interface ResolvedNavItem {
  label: string;
  href: string;
  /** Leaves this site. Themes should mark it for the reader. */
  external: boolean;
  /** Open in a new tab (and therefore also `rel="noopener"`). */
  newTab: boolean;
  /** This is the page being viewed — render `aria-current="page"`. */
  current: boolean;
  children: ResolvedNavItem[];
}

/** No control characters in anything that reaches the page. */
const CONTROL = /[\u0000-\u001F\u007F]/;
const LOCALE_KEY = /^[a-z]{2,3}$/;

/**
 * Is this href a shape we will put in an `<a>` on every page?
 *
 * Returns null when it is fine, and otherwise a sentence an operator can act
 * on. Deliberately an allow-list of shapes: there are more ways to write an
 * executable URL than anyone can enumerate (`javascript:`, `JaVaScRiPt:`,
 * `java\tscript:`, `data:`, `vbscript:`), and all of them fail by not being one
 * of the five things below.
 */
export function navHrefProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'must be a link';
  const href = raw.trim();
  if (!href) return 'must not be empty';
  if (href.length > NAV_LIMITS.href) return `must be at most ${NAV_LIMITS.href} characters`;
  if (CONTROL.test(href) || /\s/.test(href)) return 'must not contain spaces or control characters';

  // `//evil.example/x` is a path to the eye and a different ORIGIN to the
  // browser, so it is refused before the root-relative case can accept it.
  if (href.startsWith('//')) return 'must not start with // — write https:// for another site';
  // Browsers read `\` as `/` in web addresses, so `/\evil.example` is
  // `//evil.example` — another site, dressed as a page on this one. No real
  // link on this site needs a backslash.
  if (href.includes('\\')) return 'must not contain a backslash (\\) — use /';
  if (href.startsWith('/')) return null;
  if (href.startsWith('#')) return null;
  if (/^https?:\/\/[^/?#]+/i.test(href)) return null;
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(href)) return null;
  if (/^tel:\+?[0-9().\-]{3,}$/i.test(href)) return null;

  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return 'must be a page on this site (/about), a web address (https://…), mailto: or tel:';
  }
  // A bare word is almost always a page the operator meant to write as a path.
  return `must start with / for a page on this site — try "/${href.replace(/^\.?\/*/, '')}"`;
}

function labelProblem(raw: unknown, where: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return `${where} needs a label`;
  if (raw.trim().length > NAV_LIMITS.label) return `${where}: the label must be at most ${NAV_LIMITS.label} characters`;
  if (CONTROL.test(raw)) return `${where}: the label must not contain control characters`;
  return null;
}

function itemProblem(raw: unknown, where: string, depth: number): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${where} is not a menu item`;
  const item = raw as Record<string, unknown>;

  const label = labelProblem(item.label, where);
  if (label) return label;
  const href = navHrefProblem(item.href);
  if (href) return `${where} ("${String(item.label).trim()}"): the link ${href}`;

  if (item.labels !== undefined && item.labels !== null) {
    if (typeof item.labels !== 'object' || Array.isArray(item.labels)) return `${where}: translations must be a list of labels by language`;
    for (const [lang, text] of Object.entries(item.labels as Record<string, unknown>)) {
      if (!LOCALE_KEY.test(lang)) return `${where}: "${lang}" is not a language code (use el, de, fr…)`;
      if (text === '' || text === null || text === undefined) continue; // an empty translation means "use the default"
      const p = labelProblem(text, `${where} (${lang})`);
      if (p) return p;
    }
  }
  if (item.newTab !== undefined && typeof item.newTab !== 'boolean') return `${where}: "open in a new tab" must be on or off`;

  if (item.children !== undefined && item.children !== null) {
    if (!Array.isArray(item.children)) return `${where}: the submenu must be a list`;
    // One level only. A second level is where header menus stop being usable
    // on a phone and start needing a hover state keyboard users cannot reach.
    if (depth > 0 && item.children.length > 0) return `${where}: a submenu item cannot have its own submenu`;
    if (item.children.length > NAV_LIMITS.children) return `${where}: at most ${NAV_LIMITS.children} items in one submenu`;
    for (let i = 0; i < item.children.length; i++) {
      const p = itemProblem(item.children[i], `${where}, submenu item ${i + 1}`, depth + 1);
      if (p) return p;
    }
  }
  return null;
}

/**
 * Validate a menu for storage. Null when it is fine, otherwise the first
 * problem, worded for the admin screen.
 *
 * Unset, null and an empty list all mean "use the theme's own links", and are
 * valid — that is how an operator resets the menu.
 */
export function validateNavigation(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'must be a menu (an object with a list of items)';
  const items = (raw as { items?: unknown }).items;
  if (items === undefined || items === null) return null;
  if (!Array.isArray(items)) return 'must have a list of items';
  if (items.length > NAV_LIMITS.items) return `must have at most ${NAV_LIMITS.items} top-level items`;
  for (let i = 0; i < items.length; i++) {
    const p = itemProblem(items[i], `Item ${i + 1}`, 0);
    if (p) return p;
  }
  return null;
}

function normaliseItem(raw: Record<string, unknown>, depth: number): NavItem {
  const item: NavItem = {
    label: String(raw.label).trim(),
    href: String(raw.href).trim(),
  };
  if (raw.labels && typeof raw.labels === 'object') {
    const labels: Record<string, string> = {};
    for (const [lang, text] of Object.entries(raw.labels as Record<string, unknown>)) {
      if (typeof text === 'string' && text.trim()) labels[lang] = text.trim();
    }
    if (Object.keys(labels).length) item.labels = labels;
  }
  if (raw.newTab === true) item.newTab = true;
  if (depth === 0 && Array.isArray(raw.children) && raw.children.length) {
    item.children = raw.children.map((c) => normaliseItem(c as Record<string, unknown>, 1));
  }
  return item;
}

/**
 * The canonical stored form of a menu that has passed `validateNavigation`.
 *
 * Trims labels and links, drops empty translations and `newTab: false`, and
 * strips empty submenus — so two menus that look the same on screen are the
 * same bytes on disk, and nothing optional is stored as noise.
 */
export function normaliseNavigation(raw: unknown): Navigation | null {
  if (validateNavigation(raw) !== null) return null;
  const items = (raw as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  return { items: items.map((i) => normaliseItem(i as Record<string, unknown>, 0)) };
}

/**
 * Read whatever is stored, tolerating anything.
 *
 * The header renders on every page, so a value that somehow fails validation —
 * written before a rule tightened, or by a storage client that skipped the
 * settings endpoint — must degrade to "no menu" rather than take the page down.
 */
export function readNavigation(stored: unknown): Navigation | null {
  let value = stored;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return normaliseNavigation(value);
}

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href) || /^(mailto|tel):/i.test(href);
}

/** The path part of an internal href, for comparing with the current page. */
function pathOf(href: string): string {
  const path = href.split(/[?#]/)[0] || '/';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Resolve a stored menu for one request: the reader's language, and the page
 * they are on.
 *
 * - An internal link is prefixed with the reader's locale, so a menu written
 *   once keeps a German reader in German — unless the operator already wrote a
 *   locale into it (`/de/about`), which is left alone rather than doubled.
 * - A label uses the reader's language when a translation exists.
 * - `newTab` is honoured only for external links. Opening another page of the
 *   same site in a new tab is a pattern accessibility guidance advises against,
 *   and the checkbox is offered for "our shop on Etsy", not for "About".
 * - `current` marks the item for the page being viewed, which the header turns
 *   into `aria-current="page"` so a screen reader can say where the reader is.
 */
export function resolveNavigation(
  nav: Navigation | null,
  opts: { locale?: string; currentPath?: string; env?: NodeJS.ProcessEnv } = {},
): ResolvedNavItem[] {
  if (!nav || nav.items.length === 0) return [];
  const env = opts.env ?? process.env;
  const lang = (opts.locale ?? '').split('-')[0].toLowerCase();
  const here = opts.currentPath ? pathOf(opts.currentPath) : '';

  const one = (item: NavItem): ResolvedNavItem => {
    const external = isExternal(item.href);
    let href = item.href;
    if (!external && href.startsWith('/') && !splitLocaleFromPath(pathOf(href), env).prefixed) {
      href = localePath(href, opts.locale, env);
    }
    const label = (lang && item.labels?.[lang]) || item.label;
    return {
      label,
      href,
      external,
      newTab: external && item.newTab === true,
      current: !external && here !== '' && pathOf(href) === here,
      children: (item.children ?? []).map(one),
    };
  };
  return nav.items.map(one);
}
