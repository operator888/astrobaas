import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';

/**
 * Returns the active theme as a FLAT settings object the customizer can load
 * directly, derived from the active theme's nested ThemeConfig (single source
 * of truth). Public — used to hydrate the customizer and any live preview.
 * Shape: { success, data: { activeTheme, settings } }.
 */
export const GET: APIRoute = async () => {
  try {
    await LocalDB.init();
    const active = await LocalDB.getActiveTheme();
    if (!active) {
      return ApiResponseBuilder.success({ activeTheme: null, settings: null }, 'No active theme');
    }
    const s = active.settings;
    const settings = {
      primaryColor: s.colors.primary,
      secondaryColor: s.colors.secondary,
      accentColor: s.colors.accent,
      backgroundColor: s.colors.background,
      textColor: s.colors.text,
      headingFont: s.typography.headingFont,
      bodyFont: s.typography.bodyFont,
      fontSize: s.typography.fontSize,
      customCSS: s.customCSS ?? '',
    };
    return ApiResponseBuilder.success({ activeTheme: active.id, settings }, 'Theme retrieved successfully');
  } catch (error) {
    console.error('Error getting theme:', error);
    return ApiResponseBuilder.serverError('Failed to fetch theme');
  }
};
