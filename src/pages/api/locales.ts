import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../lib/api-response';
import { locales, defaultLocale, isMultilingual } from '../../lib/i18n';

/**
 * Public locale configuration.
 *
 * Headless frontends and AI agents need to know which languages a site serves
 * before they can request content in one, and there is nothing sensitive here —
 * the locales are visible in the URLs anyway. Part of the agent-readable
 * contract alongside /llms.txt and /openapi.json.
 */
export const prerender = false;

export const GET: APIRoute = async () => {
  return ApiResponseBuilder.success(
    {
      locales: locales(),
      default: defaultLocale(),
      multilingual: isMultilingual(),
    },
    'Locales retrieved',
  );
};
