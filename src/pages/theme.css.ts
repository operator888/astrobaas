import type { APIRoute } from 'astro';
import { LocalDB } from '../lib/localdb';
import { sanitizeCustomCss, sanitizeThemeCss } from '../lib/sanitize';
import type { ThemeConfig } from '../core/models';
import { resolveScale, deriveDarkPalette, readableOn } from '../lib/theme-tokens';
import { resolveActiveTheme } from '../lib/theme-runtime';
import { mergeThemeSettings } from '../lib/theme-inherit';

/**
 * The active theme's design tokens as an external stylesheet.
 *
 * These used to live in an inline `style` attribute on <html>, but the
 * hash-based CSP (no `'unsafe-inline'`) blocks inline styles. Serving them as a
 * same-origin stylesheet keeps them CSP-clean AND flash-free: it's a
 * render-blocking `<link>` in <head>, so the theme still applies on first paint.
 *
 * `:root:root` (specificity 0,2,0) is used so these win over the `:root`
 * defaults in the global stylesheet regardless of load order.
 */
export const prerender = false;

// Strip anything that could break out of the `--var: value;` context so a
// theme value from the DB can't inject arbitrary CSS rules.
function safe(v: unknown): string {
  return String(v ?? '').replace(/[;{}<>\\]/g, '').replace(/[\r\n]/g, ' ').trim().slice(0, 120);
}

/**
 * Build the light-mode declarations for a theme.
 *
 * Free-form values (colours, font families) go through `safe()` — a denylist,
 * because the operator genuinely authors them. Enum values go through
 * `resolveScale()` — an allow-list, because the stored value only ever selects
 * a pre-authored block. Two different tools because they are two different
 * kinds of input.
 */
function lightTokens(settings: ThemeConfig): Record<string, string> {
  // Defaulted, not assumed. A theme installed from npm can legitimately omit
  // `settings` entirely — a pure child theme that only overrides a component
  // has no tokens of its own — and this function is called OUTSIDE the try
  // block below. Dereferencing `settings.typography` on one of those threw,
  // which meant a 500 on the site's only stylesheet: every page unstyled,
  // because of a theme. `{}` here yields empty values, which the `||` fallbacks
  // downstream already handle.
  const c = settings.colors ?? ({} as ThemeConfig['colors']);
  const t = settings.typography ?? ({} as ThemeConfig['typography']);
  const style = settings.style ?? {};

  const primary = safe(c.primary);
  const tokens: Record<string, string> = {
    '--primary-color': primary,
    '--secondary-color': safe(c.secondary),
    '--accent-color': safe(c.accent),
    '--background-color': safe(c.background),
    '--text-color': safe(c.text),
    // Semantic colours. `onPrimary` is derived when unset so a light brand
    // colour never ends up with white text on it.
    '--surface-color': safe(c.surface) || '#ffffff',
    '--muted-color': safe(c.muted) || '#6b7280',
    '--border-color': safe(c.border) || '#e5e7eb',
    '--on-primary': safe(c.onPrimary) || (/^#[0-9a-f]{6}$/i.test(primary) ? readableOn(primary) : '#ffffff'),
    '--success-color': safe(c.success) || '#059669',
    '--warning-color': safe(c.warning) || '#d97706',
    '--danger-color': safe(c.danger) || '#dc2626',

    '--heading-font': safe(t.headingFont),
    '--body-font': safe(t.bodyFont),
    '--font-size-base': safe(t.fontSize),
    '--letter-spacing': safe(t.letterSpacing) || 'normal',
  };

  // Enum groups: each contributes several declarations.
  Object.assign(tokens, resolveScale('typeScale', t.scale));
  Object.assign(tokens, resolveScale('headingWeight', t.headingWeight));
  Object.assign(tokens, resolveScale('radius', style.radius));
  Object.assign(tokens, resolveScale('density', style.density));
  Object.assign(tokens, resolveScale('shadow', style.shadow));
  Object.assign(tokens, resolveScale('containerWidth', style.containerWidth));
  Object.assign(tokens, resolveScale('buttonStyle', style.buttonStyle));
  Object.assign(tokens, resolveScale('headerStyle', style.headerStyle));
  return tokens;
}

/** Dark declarations: the theme's own if authored, otherwise derived. */
function darkTokens(settings: ThemeConfig): Record<string, string> {
  const d = settings.darkColors ?? {};
  const derived = deriveDarkPalette({
    primary: safe(settings.colors.primary),
    secondary: safe(settings.colors.secondary),
    accent: safe(settings.colors.accent),
    background: safe(settings.colors.background),
    text: safe(settings.colors.text),
  });
  // An authored value always wins; anything the theme left out is derived, so a
  // partial dark palette is legal and useful.
  const authored: Record<string, string> = {};
  const put = (token: string, v: unknown) => { const x = safe(v); if (x) authored[token] = x; };
  put('--primary-color', d.primary);
  put('--secondary-color', d.secondary);
  put('--accent-color', d.accent);
  put('--background-color', d.background);
  put('--surface-color', d.surface);
  put('--text-color', d.text);
  put('--muted-color', d.muted);
  put('--border-color', d.border);
  const merged = { ...derived, ...authored };
  if (merged['--primary-color'] && /^#[0-9a-f]{6}$/i.test(merged['--primary-color'])) {
    merged['--on-primary'] = readableOn(merged['--primary-color']);
  }
  return merged;
}

const block = (selector: string, tokens: Record<string, string>) => {
  const decls = Object.entries(tokens)
    .filter(([, v]) => String(v).length > 0)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
  return decls ? `${selector} { ${decls} }` : '';
};

export const GET: APIRoute = async () => {
  let settings: ThemeConfig | null = null;
  let customCss = '';
  // A theme's own stylesheet. Served here rather than as its own route so the
  // site still makes exactly one stylesheet request, and so it lands AFTER the
  // token declarations — a theme rule that references var(--primary-color)
  // needs the variable to already be defined.
  let themeCss = '';
  try {
    await LocalDB.init();
    const theme = await LocalDB.getActiveTheme();
    // One source for both tiers: `resolveActiveTheme` already decided whether
    // the stylesheet comes from a compiled-in module or an installed manifest.
    // Branching on the tier here would be a second place for them to disagree.
    const resolvedTheme = await resolveActiveTheme();
    themeCss = sanitizeThemeCss(resolvedTheme.css, (reason) =>
      console.warn(`[astrobaas] theme "${resolvedTheme.id}" stylesheet not served: ${reason}`));
    if (theme?.settings || resolvedTheme.definition?.settings) {
      // Re-sanitize on the way out as well as on write, so a value written by
      // an older build (or edited directly in the DB) is still cleaned.
      customCss = sanitizeCustomCss(theme?.settings?.customCSS ?? '');
      // INHERITED defaults first, the operator's stored row on top (C-170).
      //
      // Reading the row alone was the bug: it is seeded from the theme's OWN
      // settings, so a child theme that set one colour rendered with none of
      // its parent's palette or typography — the per-leaf merge had no runtime
      // effect at all. Per leaf in both directions, so a child inherits what it
      // did not set and the operator still wins over both.
      settings = mergeThemeSettings<ThemeConfig>(
        resolvedTheme.definition?.settings,
        theme?.settings,
      );
    }
  } catch {
    // DB not ready (racing the seed) — emit an empty rule; global.css defaults apply.
  }

  let body: string;
  if (!settings) {
    body = ':root:root { }\n';
  } else {
    const scheme = settings.colorScheme === 'dark' || settings.colorScheme === 'auto'
      ? settings.colorScheme : 'light';
    const light = block(':root:root', lightTokens(settings));
    const dark = darkTokens(settings);

    const parts = [light];
    if (scheme === 'dark') {
      // Forced dark: fold it straight into :root so there is nothing to toggle.
      parts.push(block(':root:root', dark));
    } else if (scheme === 'auto') {
      // Follow the OS...
      parts.push(`@media (prefers-color-scheme: dark) { ${block(':root:root:not([data-theme="light"])', dark)} }`);
      // ...but let an explicit choice win in BOTH directions. The visitor's
      // toggle stamps data-theme on <html>; the server renders that attribute
      // from a cookie, so the correct scheme is in the first byte of HTML and
      // there is no flash and no inline script.
      parts.push(block(':root:root[data-theme="dark"]', dark));
    }
    body = parts.filter(Boolean).join('\n') + '\n';
  }
  // Order is the contract: tokens, then the theme's stylesheet, then the
  // operator's custom CSS last so an operator can always override their theme.
  if (themeCss) body += `\n/* theme stylesheet */\n${themeCss}\n`;
  if (customCss) body += `\n/* custom CSS */\n${customCss}\n`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      // Always revalidate so a theme change in the admin takes effect on the very
      // next page load (the file is tiny; the extra request is negligible).
      'Cache-Control': 'no-cache',
    },
  });
};
