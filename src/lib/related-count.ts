/**
 * How many related posts to show — resolved in ONE place.
 *
 * The renderer defaulted to 3 when the setting was unset; the settings screen
 * displayed 0 for the same unset value. So a fresh install showed three related
 * articles under every post while the box an operator opens to control it read
 * "0" — a number that, if they saved the form without touching it, would then
 * actually turn the feature off. Two defaults for one setting is the drift this
 * module exists to make impossible.
 *
 * Also the seam the API route and the SSR route share (C-147), so a headless
 * storefront and the server-rendered blog agree on how many they get.
 */
import { settingInt } from './settings-map';

/** Shown when the operator has never touched the setting. */
export const RELATED_COUNT_DEFAULT = 3;

/** Hard ceiling, matching the `max` on the admin input. */
export const RELATED_COUNT_MAX = 12;

/**
 * `0` is a real answer and means "show none" — which is why this cannot use
 * `|| DEFAULT`. `settingInt` already distinguishes an unset value from a
 * deliberate zero, because `Number('')` is 0 and a cleared box must not read as
 * a choice.
 */
export function relatedCount(value: unknown): number {
  return settingInt(value, RELATED_COUNT_DEFAULT, { min: 0, max: RELATED_COUNT_MAX });
}
