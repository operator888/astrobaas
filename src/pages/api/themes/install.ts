import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validateThemeManifest } from '../../../lib/theme-manifest';
import { isDeclarativeTheme } from '../../../core/theme-manifest';
import { BUNDLED_THEMES } from '../../../themes';
import defaultTheme from '../../../themes/default';
import type { ThemeConfig } from '../../../core/models';

/**
 * The stock token set, used to fill anything a manifest leaves out.
 *
 * Taken from the bundled default theme rather than restated here, so a theme
 * that sets two colours gets sensible values for the rest instead of a
 * half-empty config that renders as unstyled.
 */
// The stock theme is a ROOT theme, so its settings are a complete palette —
// which is what these defaults have to be to fill a manifest's gaps.
const DEFAULT_THEME_TOKENS = defaultTheme.settings as ThemeConfig;

/**
 * Install / uninstall a DECLARATIVE theme (a JSON manifest).
 *
 * This is the runtime tier. A manifest carries design tokens, a stylesheet and
 * section patterns — data only. No components, no code, nothing that needs a
 * bundler, which is exactly why it can be installed without a rebuild while a
 * bundled theme cannot.
 *
 *   POST   { manifest, source? } → install or upgrade
 *   DELETE { id }                → uninstall (declarative only)
 *
 * Admin only. A theme decides what every visitor sees, so this sits at the same
 * privilege level as editing settings, not at editor level.
 *
 * Installing does NOT activate. Two reasons: an operator should be able to look
 * at a theme in the list before pointing their live site at it, and an upgrade
 * of an inactive theme must not silently become a redesign.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return ApiResponseBuilder.badRequest('Body must be a JSON object.');

    const raw = (body as { manifest?: unknown }).manifest;
    if (raw === undefined) return ApiResponseBuilder.badRequest('Missing `manifest`.');

    const result = validateThemeManifest(raw, { reservedIds: BUNDLED_THEMES.map((t) => t.id) });
    if (!result.ok || !result.manifest) {
      // Pattern rejections travel with their diff — the submitted markup beside
      // what the sanitizer returned — because "rejected" is not something a
      // theme author can act on and a diff is.
      return ApiResponseBuilder.validationError('Invalid theme manifest', {
        errors: result.errors,
        ...(result.rejectedPatterns?.length ? { patterns: result.rejectedPatterns } : {}),
      });
    }
    const manifest = result.manifest;

    const existing = (await LocalDB.getThemes()).find((t) => t.id === manifest.id);
    if (existing && !isDeclarativeTheme(existing)) {
      return ApiResponseBuilder.badRequest(
        `"${manifest.id}" already exists and was not installed from a manifest.`,
      );
    }

    const source = typeof (body as { source?: unknown }).source === 'string'
      ? String((body as { source: string }).source).slice(0, 100)
      : 'upload';

    // The manifest's tokens are the theme's DEFAULTS — what the site looks like
    // before anyone customizes it. They seed `settings` on first install only;
    // on upgrade the storage layer preserves whatever the operator has since
    // tuned, because a version bump silently reverting their colours would be
    // the theme equivalent of overwriting someone's content.
    const seeded: ThemeConfig = {
      ...DEFAULT_THEME_TOKENS,
      ...(manifest.tokens ?? {}),
      colors: { ...DEFAULT_THEME_TOKENS.colors, ...(manifest.tokens?.colors ?? {}) },
      typography: { ...DEFAULT_THEME_TOKENS.typography, ...(manifest.tokens?.typography ?? {}) },
      ...(manifest.tokens?.style ? { style: manifest.tokens.style } : {}),
    };

    const saved = await LocalDB.upsertDeclarativeTheme({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description ?? '',
      version: manifest.version,
      author: manifest.author ?? '',
      ...(manifest.screenshot ? { screenshot: manifest.screenshot } : {}),
      manifest,
      installed_from: source,
      status: 'inactive',
      settings: seeded,
      created_at: new Date().toISOString(),
    });

    return ApiResponseBuilder.created(
      {
        id: manifest.id,
        version: manifest.version,
        upgraded: !!existing,
        patterns: manifest.patterns?.length ?? 0,
        hasCss: !!manifest.css,
        active: saved?.status === 'active',
      },
      existing
        ? `Theme upgraded to ${manifest.version}. Your customized colours were kept.`
        : 'Theme installed. Activate it from the themes list.',
    );
  } catch (err) {
    console.error('Theme install error:', err);
    return ApiResponseBuilder.serverError('Failed to install theme');
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const id = typeof (body as { id?: unknown })?.id === 'string' ? (body as { id: string }).id : '';
    if (!id) return ApiResponseBuilder.badRequest('Missing `id`.');

    if (BUNDLED_THEMES.some((t) => t.id === id)) {
      return ApiResponseBuilder.badRequest(
        'Bundled themes cannot be uninstalled — remove the import and rebuild.',
      );
    }

    const existing = (await LocalDB.getThemes()).find((t) => t.id === id);
    if (!existing) return ApiResponseBuilder.notFound('Theme not found');
    if (!isDeclarativeTheme(existing)) {
      return ApiResponseBuilder.badRequest('Only themes installed from a manifest can be uninstalled here.');
    }
    // Refusing to delete the ACTIVE theme is the whole guard: removing it would
    // leave the site resolving an id with nothing behind it. Switch first, so
    // the operator chooses the replacement rather than being given one.
    if (existing.status === 'active') {
      return ApiResponseBuilder.badRequest(
        'This theme is active. Activate a different theme first, then uninstall it.',
      );
    }

    await LocalDB.deleteTheme(id);
    return ApiResponseBuilder.success({ id }, 'Theme uninstalled.');
  } catch (err) {
    console.error('Theme uninstall error:', err);
    return ApiResponseBuilder.serverError('Failed to uninstall theme');
  }
};
