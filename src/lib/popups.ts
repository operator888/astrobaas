/**
 * Opt-in overlays, the honest version (C-114).
 *
 * ## Why this is a plugin and not a feature
 *
 * The roadmap said so, and the reason is worth keeping: a popup is the one
 * thing on a site that exists to interrupt the reader. An install that has not
 * asked for one should not carry the code, and switching it off should mean the
 * code is not served at all — not that a flag is false somewhere.
 *
 * ## The three rules that make it usable rather than hostile
 *
 * **Frequency cap.** Shown once, then not again for N days, per browser. A
 * popup with no cap is the pattern every reader has learned to close without
 * reading, which makes it useless as well as unpleasant.
 *
 * **Dismissal is remembered, and so is signing up.** Somebody who joined the
 * list must never see "join the list" again — that is the single most common
 * complaint about these things and it is entirely avoidable.
 *
 * **It is not a consent wall.** It never covers the whole page, it never traps
 * focus, and Escape closes it. A modal that blocks the article until you hand
 * over an address is the shape regulators have fined and readers bounce from.
 *
 * ## Consent-aware, in the direction that matters
 *
 * The popup itself needs no consent — it stores one small flag, and that flag
 * is strictly necessary to honour the reader's own "no". What it must NOT do is
 * appear on top of the consent banner: a reader being asked about cookies is
 * already being interrupted, and stacking a second overlay is how both get
 * dismissed unread. So it waits for a consent decision to exist before it ever
 * shows.
 */
import { settingBool } from './settings-map';
export const POPUP_KEYS = {
  enabled: 'popup_enabled',
  title: 'popup_title',
  text: 'popup_text',
  buttonLabel: 'popup_button_label',
  /** Where the button goes. Empty means the built-in newsletter form. */
  buttonUrl: 'popup_button_url',
  trigger: 'popup_trigger',
  delaySeconds: 'popup_delay_seconds',
  scrollPercent: 'popup_scroll_percent',
  frequencyDays: 'popup_frequency_days',
} as const;

export type PopupTrigger = 'delay' | 'scroll' | 'exit';

export const POPUP_TRIGGERS: readonly PopupTrigger[] = ['delay', 'scroll', 'exit'];

export interface PopupConfig {
  enabled: boolean;
  title: string;
  text: string;
  buttonLabel: string;
  buttonUrl: string;
  trigger: PopupTrigger;
  delaySeconds: number;
  scrollPercent: number;
  frequencyDays: number;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * A button URL that is safe to put in an `href` on every public page.
 *
 * Admin-only to set, so this is hardening rather than a hole — but an
 * unvalidated URL reaching `link.href` accepts `javascript:`, and "only an
 * admin can do it" is the argument that precedes every stored-XSS incident
 * involving a compromised admin session.
 *
 * A relative path or an http(s) URL. Anything else becomes empty, which falls
 * back to the built-in newsletter form rather than rendering a dead button.
 */
function safeUrl(value: string): string {
  const v = value.trim();
  if (!v) return '';
  // A leading `//` is protocol-relative — same class of bypass the embed
  // poster guard had to close.
  if (/^\/(?![/\\])/.test(v)) return v;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' || url.protocol === 'http:' ? v : '';
  } catch {
    return '';
  }
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  const raw = String(v ?? '').trim();
  // ABSENT IS NOT ZERO. `Number('')` is 0, which is finite — so an unset
  // setting fell through the NaN check and was then clamped to the MINIMUM.
  // Every default in this module was silently its own floor: a fresh install
  // showed the popup after one second, at 5% scroll, every single day. That is
  // the exact opposite of the frequency cap this module exists to provide, and
  // it was invisible in the code and obvious in a screenshot of the settings
  // form.
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Read the popup out of the settings map.
 *
 * Bounded on every axis, because these numbers reach a timer and a scroll
 * listener in a reader's browser. A delay of `-1` or `1e9` is a typo, and the
 * result of trusting it is either a popup that appears instantly on every page
 * or one that never appears and cannot be debugged.
 */
export function resolvePopup(settings: Record<string, unknown>): PopupConfig {
  const rawTrigger = String(settings[POPUP_KEYS.trigger] ?? '').trim().toLowerCase();
  return {
    // The shared helper, rather than the hand-rolled pair this used to be.
    //
    // The old line was `=== true || === 'true'`, with a comment blaming the
    // relational driver for storing settings as TEXT. That cause is not real —
    // all three drivers store a Setting as a JSON document and hand a boolean
    // back as a boolean, which was measured. The string comes from
    // `POST /api/settings/update`, which takes arbitrary JSON and coerces only
    // the keys in BOOLEAN_KEYS. Handling exactly "true" therefore covered one
    // of the four affirmatives the rest of the product accepts and none of the
    // negatives, so "0" and "off" both switched the popup ON.
    enabled: settingBool(settings[POPUP_KEYS.enabled], false),
    title: str(settings[POPUP_KEYS.title], 120),
    text: str(settings[POPUP_KEYS.text], 400),
    buttonLabel: str(settings[POPUP_KEYS.buttonLabel], 60) || 'Subscribe',
    buttonUrl: safeUrl(str(settings[POPUP_KEYS.buttonUrl], 500)),
    trigger: (POPUP_TRIGGERS as readonly string[]).includes(rawTrigger) ? rawTrigger as PopupTrigger : 'delay',
    delaySeconds: int(settings[POPUP_KEYS.delaySeconds], 15, 1, 600),
    scrollPercent: int(settings[POPUP_KEYS.scrollPercent], 50, 5, 100),
    // Zero would mean "every page view", which is the pattern this module
    // exists to avoid. One day is the floor.
    frequencyDays: int(settings[POPUP_KEYS.frequencyDays], 14, 1, 365),
  };
}

/**
 * Is there anything to show?
 *
 * Enabled AND has words. An operator who ticked the box and never wrote the
 * text would otherwise get an empty grey rectangle over their article, which
 * looks like a bug in the CMS rather than an unfinished setting.
 */
export function popupIsShowable(cfg: PopupConfig): boolean {
  return cfg.enabled && cfg.title.length > 0 && cfg.text.length > 0;
}

/** What the browser is told. No secrets — every field is public copy. */
export function popupPayload(cfg: PopupConfig): Omit<PopupConfig, 'enabled'> | null {
  if (!popupIsShowable(cfg)) return null;
  const { enabled: _enabled, ...rest } = cfg;
  return rest;
}

/** The browser-storage key holding "seen at" / "done". One name, two readers. */
export const POPUP_STORAGE_KEY = 'astrobaas_popup';

/**
 * How often the browser re-checks whether the consent banner has been answered.
 *
 * Bounded retries rather than a MutationObserver: the banner is a served script
 * this one does not import, and observing the whole document to notice it leave
 * costs more than twenty cheap cookie reads.
 */
export const CONSENT_WAIT_MS = 1500;

/**
 * Should the popup show, given what this browser remembers?
 *
 * Pure and exported so the rule is testable without a DOM — the frequency cap
 * is the part that is easy to get subtly wrong and impossible to notice, since
 * getting it wrong shows MORE popups and nobody files that as a bug.
 */
export function popupShouldShow(
  stored: { seen?: number; done?: boolean } | null,
  frequencyDays: number,
  nowMs: number,
): boolean {
  if (!stored) return true;
  // Somebody who joined the list must never be asked to join the list.
  if (stored.done === true) return false;
  if (typeof stored.seen !== 'number' || !Number.isFinite(stored.seen)) return true;
  // A clock that moved backwards (a traveller, a corrected system time) must
  // not unlock the popup — treat any future timestamp as "just seen".
  if (stored.seen > nowMs) return false;
  return nowMs - stored.seen >= frequencyDays * 24 * 60 * 60 * 1000;
}
