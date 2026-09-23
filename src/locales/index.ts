/**
 * The catalogues this build ships.
 *
 * Registered once at import. Adding a CORE language is a line here plus a file;
 * adding one WITHOUT touching this repository is `registerCatalogue()` from a
 * plugin, which is how a community or paid language pack works.
 *
 * Which of these a site actually offers is still `SITE_LOCALES` — shipping a
 * catalogue does not enable a language, because a half-translated locale should
 * be something an operator opts into rather than something that appears.
 */
import { registerCatalogue } from '../lib/i18n/translate';
import { en } from './en/index';
import { el } from './el/index';
import { de } from './de/index';

export const BUNDLED_CATALOGUES: Readonly<Record<string, typeof en>> = { en, el, de };

let registered = false;

/** Idempotent: safe to call from every entry point that needs translations. */
export function registerBundledCatalogues(): void {
  if (registered) return;
  registered = true;
  for (const [locale, catalogue] of Object.entries(BUNDLED_CATALOGUES)) {
    registerCatalogue(locale, catalogue);
  }
}

export { en, el, de };
