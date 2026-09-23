/**
 * The print affordance (C-152).
 *
 * The rules themselves live in `@media print` in global.css. This module owns
 * the one thing that has to agree in more than one place: whether the button is
 * shown. The route asks, the settings screen renders the checkbox, and the
 * update endpoint whitelists the key — three readers of one default, which is
 * exactly the shape that drifts when each writes its own `?? true`.
 */
import { settingBool } from './settings-map';

export const PRINT_BUTTON_SETTING = 'print_button';

/**
 * Default ON, unlike most switches here.
 *
 * The print stylesheet already applies to every article on every install; a
 * reader simply has no way to discover it. Defaulting off would ship the
 * affordance into a settings list nobody opens — the exact failure the print
 * rules themselves had before they were moved out of an inactive plugin.
 */
export const PRINT_BUTTON_DEFAULT = true;

export function printButtonEnabled(value: unknown): boolean {
  return settingBool(value, PRINT_BUTTON_DEFAULT);
}
