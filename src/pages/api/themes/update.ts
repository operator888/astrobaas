import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import type { ThemeConfig } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { sanitizeCustomCss } from '../../../lib/sanitize';
import { isTokenKey } from '../../../lib/theme-tokens';

/**
 * Persist customizer changes into the ACTIVE theme's nested ThemeConfig (the
 * single source of truth that SSR reads in BaseLayout). The customizer sends a
 * flat payload; we map it onto the nested shape here. Also mirrors site
 * title/tagline into the settings table so the public site picks them up.
 */
const HEX = /^#[0-9a-fA-F]{3,8}$/;
function hex(v: any, fallback: string): string {
  return typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : fallback;
}
function font(v: any, fallback: string): string {
  return typeof v === 'string' && /^[\w\s-]{1,40}$/.test(v) ? v : fallback;
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const flat = body?.settings;
    if (!flat || typeof flat !== 'object') {
      return ApiResponseBuilder.badRequest('Missing theme settings');
    }

    const active = await LocalDB.getActiveTheme();
    if (!active) return ApiResponseBuilder.badRequest('No active theme');

    // Map the flat customizer payload onto the nested ThemeConfig, keeping any
    // existing values the customizer didn't send.
    const cur = active.settings;
    // Enum fields: keep the stored value unless the incoming one is a KEY the
    // vocabulary actually defines. Unknown keys are dropped rather than stored,
    // so /theme.css never has to defend against a value that reached the DB.
    const enumOf = (name: Parameters<typeof isTokenKey>[0], v: any, fallback: string | undefined) =>
      (typeof v === 'string' && isTokenKey(name, v)) ? v : fallback;

    // Optional free-form colour: undefined stays undefined, so an unset
    // semantic colour keeps falling back to the global.css default rather than
    // being frozen to whatever the first save happened to contain.
    const optHex = (v: any, fallback: string | undefined) =>
      typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : fallback;

    const config: ThemeConfig = {
      colors: {
        primary: hex(flat.primaryColor, cur.colors.primary),
        secondary: hex(flat.secondaryColor, cur.colors.secondary),
        accent: hex(flat.accentColor, cur.colors.accent),
        background: hex(flat.backgroundColor, cur.colors.background),
        text: hex(flat.textColor, cur.colors.text),
        surface: optHex(flat.surfaceColor, cur.colors.surface),
        muted: optHex(flat.mutedColor, cur.colors.muted),
        border: optHex(flat.borderColor, cur.colors.border),
        onPrimary: optHex(flat.onPrimaryColor, cur.colors.onPrimary),
        success: optHex(flat.successColor, cur.colors.success),
        warning: optHex(flat.warningColor, cur.colors.warning),
        danger: optHex(flat.dangerColor, cur.colors.danger),
      },
      typography: {
        headingFont: font(flat.headingFont, cur.typography.headingFont),
        bodyFont: font(flat.bodyFont, cur.typography.bodyFont),
        fontSize: typeof flat.fontSize === 'string' ? flat.fontSize : cur.typography.fontSize,
        scale: enumOf('typeScale', flat.typeScale, cur.typography.scale),
        headingWeight: enumOf('headingWeight', flat.headingWeight, cur.typography.headingWeight),
        letterSpacing: typeof flat.letterSpacing === 'string' && /^[-\d.a-z]{1,12}$/i.test(flat.letterSpacing)
          ? flat.letterSpacing : cur.typography.letterSpacing,
      },
      style: {
        radius: enumOf('radius', flat.radius, cur.style?.radius),
        density: enumOf('density', flat.density, cur.style?.density),
        shadow: enumOf('shadow', flat.shadow, cur.style?.shadow),
        containerWidth: enumOf('containerWidth', flat.containerWidth, cur.style?.containerWidth),
        buttonStyle: enumOf('buttonStyle', flat.buttonStyle, cur.style?.buttonStyle),
        headerStyle: enumOf('headerStyle', flat.headerStyle, cur.style?.headerStyle),
      },
      colorScheme: ['light', 'dark', 'auto'].includes(flat.colorScheme)
        ? flat.colorScheme : (cur.colorScheme ?? 'light'),
      darkColors: {
        primary: optHex(flat.darkPrimary, cur.darkColors?.primary),
        secondary: optHex(flat.darkSecondary, cur.darkColors?.secondary),
        accent: optHex(flat.darkAccent, cur.darkColors?.accent),
        background: optHex(flat.darkBackground, cur.darkColors?.background),
        surface: optHex(flat.darkSurface, cur.darkColors?.surface),
        text: optHex(flat.darkText, cur.darkColors?.text),
        muted: optHex(flat.darkMuted, cur.darkColors?.muted),
        border: optHex(flat.darkBorder, cur.darkColors?.border),
      },
      // Operator CSS: sanitized here (and again when served) so a stored value
      // can never close the <style>/<script> context or smuggle markup.
      customCSS:
        typeof flat.customCSS === 'string' ? sanitizeCustomCss(flat.customCSS) : cur.customCSS,
    };

    const updated = await LocalDB.updateThemeSettings(active.id, config);

    // Mirror site identity into settings so the public site reflects it.
    if (typeof flat.siteTitle === 'string' && flat.siteTitle.trim()) {
      await LocalDB.updateSetting('site_title', flat.siteTitle.trim());
    }
    if (typeof flat.siteTagline === 'string' && flat.siteTagline.trim()) {
      await LocalDB.updateSetting('site_tagline', flat.siteTagline.trim());
    }

    return ApiResponseBuilder.success(updated, 'Theme updated successfully');
  } catch (error) {
    console.error('Error updating theme:', error);
    return ApiResponseBuilder.serverError('Failed to update theme');
  }
};
