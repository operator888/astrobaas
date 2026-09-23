/**
 * Is the opt-in overlay actually live on this install? (C-114)
 *
 * Two callers have to agree: `BaseLayout` decides whether to emit the script
 * tag, and `/popup.js` decides whether to answer with a script. Answering the
 * question twice is how they drift, and the drift is invisible in both
 * directions — a tag for a popup that never renders, or (worse) no tag for a
 * popup the operator has configured and cannot see.
 *
 * The same shape and the same reasoning as `assistant-runtime.ts`, which was
 * written after exactly that bug.
 */
import { LocalDB } from './localdb';
import { pluginManager } from './plugin-system';
import { resolvePopup, popupIsShowable } from './popups';

export const POPUPS_PLUGIN_ID = 'popups';

/** Live means BOTH: the plugin is active AND there is copy to show. */
export async function popupsAreLive(): Promise<boolean> {
  try {
    const active = pluginManager.getActivePlugins?.().some?.(
      (p: { id?: string }) => p.id === POPUPS_PLUGIN_ID,
    ) ?? false;
    if (!active) return false;

    const rows = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;
    return popupIsShowable(resolvePopup(map));
  } catch {
    // A layout must render even when the database is mid-seed, and the failure
    // that matters here is a blank page, not a missing popup.
    return false;
  }
}
