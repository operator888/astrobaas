/**
 * Is the AI assistant actually live on this install?
 *
 * ## Why this module exists
 *
 * The homepage says the client JavaScript is "a cookie-consent manager, and the
 * AI assistant **if you enable it**". `BaseLayout.astro` emitted
 * `<script src="/assistant.js">` unconditionally, so a fresh install with no
 * assistant configured still downloaded it on every public page. The feature was
 * conditional; the download was not. A reader hears that sentence as describing
 * the download, so the sentence was false — recorded as audit item A-4.
 *
 * The fix needs the layout and the endpoint to agree on one question: *is the
 * assistant live?* Answering it twice is how they drift, and drift here is
 * invisible — the tag would be emitted for an assistant that never renders, or
 * (far worse) omitted for one that works. This codebase's most reliable bug
 * shape is a rule fixed in one place and missed in its sibling, so the rule
 * lives here and both callers ask it.
 *
 * ## Live means BOTH things
 *
 * Two independent switches, and the pre-existing endpoint already required
 * both — this module just names the conjunction:
 *
 *   1. the `ai-assistant` plugin is ACTIVE, and
 *   2. its settings are COMPLETE — `assistantReady()`: enabled, plus an API
 *      key, base URL and model.
 *
 * A plugin that is active but unconfigured is the common half-finished state
 * (someone toggled it on, then went to find their API key). It renders nothing,
 * so it must not cost a request.
 *
 * ## What this deliberately does NOT do
 *
 * It does not bootstrap the plugin registry. Both callers run inside a request,
 * and `src/middleware.ts` has already called `ensurePluginsBootstrapped()` by
 * then. Importing that here would point `lib/` at `plugins/`, inverting the
 * layering for no gain.
 *
 * It also returns nothing secret. The API key stays server-side; callers that
 * need a browser-safe payload pass the result through `publicAssistantConfig()`,
 * which remains the single place that decides what a visitor may see.
 */
import { LocalDB } from './localdb';
import { pluginManager } from './plugin-system';
import { resolveAssistantConfig, assistantReady, type AssistantConfig } from './ai-assistant';

/** Plugin id, matching `src/plugins/ai-assistant/index.ts`. */
export const ASSISTANT_PLUGIN_ID = 'ai-assistant';

/**
 * The resolved assistant config if the assistant is live, otherwise `null`.
 *
 * Returns the CONFIG rather than a boolean so `/assistant.js` does not have to
 * resolve settings a second time to build its payload.
 */
export async function liveAssistantConfig(): Promise<AssistantConfig | null> {
  const active = pluginManager.getActivePlugins?.().some?.(
    (p: { id?: string }) => p.id === ASSISTANT_PLUGIN_ID,
  ) ?? false;
  if (!active) return null;

  const rows = await LocalDB.getSettings();
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;

  const cfg = resolveAssistantConfig(map, process.env as Record<string, string | undefined>);
  return assistantReady(cfg) ? cfg : null;
}

/**
 * Should this page emit `<script src="/assistant.js">`?
 *
 * Never throws: a layout must render even when the database is mid-seed, and
 * the failure that matters here is a blank page, not a missing chat bubble.
 */
export async function assistantIsLive(): Promise<boolean> {
  try {
    return (await liveAssistantConfig()) !== null;
  } catch {
    return false;
  }
}
