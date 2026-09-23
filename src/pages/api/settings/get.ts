import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { visibleSettings } from '../../../lib/settings-visibility';

/**
 * GET /api/settings/get — public read, but NOT a dump of the settings table.
 *
 * Settings are schemaless, so whatever an operator or plugin stores ends up
 * here. Anonymous callers see only keys that are explicitly public (see
 * settings-visibility.ts); staff sessions see everything.
 */
export const GET: APIRoute = async ({ locals }) => {
  try {
    await LocalDB.init();
    const settings = await LocalDB.getSettings();
    const all: Record<string, any> = {};
    settings.forEach(s => {
      all[s.key] = s.value;
    });

    const role = locals.user?.role;
    const isStaff = role === 'admin' || role === 'editor';
    return ApiResponseBuilder.success(
      visibleSettings(all, isStaff),
      'Settings retrieved successfully',
    );
  } catch (error) {
    console.error('Error fetching settings:', error);
    return ApiResponseBuilder.serverError('Failed to fetch settings');
  }
};
