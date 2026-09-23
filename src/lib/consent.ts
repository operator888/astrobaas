/**
 * Consent state — GDPR (Art. 4(11), 7) and the ePrivacy Directive (Art. 5(3)).
 *
 * The rules this encodes, because each one is a way real cookie banners fail:
 *
 *  - **Prior consent.** Non-essential storage may not happen before the visitor
 *    opts in. A banner that fires analytics on page load and asks afterwards is
 *    not consent, it is notification. Hence: unknown state means *denied*, and
 *    the loader waits.
 *  - **No pre-ticked boxes.** Silence, inactivity, or a pre-checked toggle is
 *    not consent. Default for every optional category is off.
 *  - **Refusing must be as easy as accepting.** One click each, same visual
 *    weight. A "Reject all" buried two screens deep is a dark pattern regulators
 *    have repeatedly fined.
 *  - **Granular.** Consent is per purpose, not one blanket yes. Accepting
 *    analytics must not enable marketing.
 *  - **Withdrawable.** It has to be as easy to take back as to give, which means
 *    a persistent way back into the settings, not a one-shot banner.
 *  - **Versioned.** If the categories or vendors change, old consent no longer
 *    covers the new processing and must be re-asked.
 *  - **Bounded lifetime.** Consent is not forever; it expires and is re-asked.
 *
 * Pure module: no storage, no DOM. The cookie is read and written by the served
 * loader script; the encoding lives here so it is testable.
 */

/**
 * Purposes a visitor consents to, coarsest-grained that is still honest.
 *
 * `necessary` is listed for completeness and is never optional — it covers the
 * session cookie and CSRF token, which are strictly required to deliver a
 * service the user asked for and are therefore exempt from the consent
 * requirement. Presenting it as a choice would be misleading.
 */
export const CONSENT_CATEGORIES = ['necessary', 'preferences', 'analytics', 'marketing'] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

/** Categories the visitor actually chooses. */
export const OPTIONAL_CATEGORIES: readonly ConsentCategory[] = ['preferences', 'analytics', 'marketing'];

export const CONSENT_COOKIE = 'astrobaas_consent';

/**
 * Bump when the categories, their meaning, or the vendor set changes.
 * A stored record from an older version does not cover the new processing, so
 * it is treated as absent and the banner returns.
 */
export const CONSENT_VERSION = 1;

/** Six months. Long enough not to nag, short enough to be a real refresh. */
export const CONSENT_MAX_AGE_DAYS = 182;

export interface ConsentRecord {
  v: number;
  /** Epoch ms when the choice was made. */
  t: number;
  /** Categories granted. `necessary` is implicit and always present. */
  granted: ConsentCategory[];
}

/**
 * Every string a visitor reads, in every locale the sites actually serve.
 *
 * Hardcoded English here failed the sites this ships to first: consent a
 * visitor cannot READ is not informed consent (GDPR Art. 7 — "clear and
 * plain language"), and both production shops are Greek. The loader picks the
 * locale from `document.documentElement.lang` at runtime, so one served file
 * covers a multilingual site with no extra requests; unknown locales fall
 * back to English.
 *
 * Descriptions stay plain-language on purpose: vague labels defeat informed
 * consent no matter the language.
 */
export interface ConsentDescriptor {
  id: ConsentCategory;
  required: boolean;
}

export const CONSENT_DESCRIPTORS: readonly ConsentDescriptor[] = [
  { id: 'necessary', required: true },
  { id: 'preferences', required: false },
  { id: 'analytics', required: false },
  { id: 'marketing', required: false },
];

export interface ConsentStrings {
  title: string;
  body: string;
  acceptAll: string;
  rejectOptional: string;
  choose: string;
  save: string;
  alwaysOn: string;
  reopen: string;
  categories: Record<ConsentCategory, { label: string; description: string }>;
}

export const CONSENT_STRINGS: Record<string, ConsentStrings> = {
  en: {
    title: 'Your privacy',
    body: 'We use strictly necessary cookies to run this site. With your permission we would also like to use optional ones. You can change your mind at any time.',
    acceptAll: 'Accept all',
    rejectOptional: 'Reject optional',
    choose: 'Choose',
    save: 'Save choices',
    alwaysOn: 'always on',
    reopen: 'Cookie settings',
    categories: {
      necessary: {
        label: 'Strictly necessary',
        description: 'Required for the site to work: signing in, security, and remembering what is in your cart. These cannot be switched off.',
      },
      preferences: {
        label: 'Preferences',
        description: 'Remembers choices you make, such as language or region, so you do not have to set them again.',
      },
      analytics: {
        label: 'Analytics',
        description: 'Helps us understand how the site is used — which pages are read, where visitors arrive from — so we can improve it. Data is aggregated.',
      },
      marketing: {
        label: 'Marketing',
        description: 'Lets advertising platforms measure whether their ads brought you here and show you more relevant ads elsewhere.',
      },
    },
  },
  el: {
    title: 'Τα δεδομένα σας',
    body: 'Χρησιμοποιούμε απολύτως απαραίτητα cookies για τη λειτουργία του ιστότοπου. Με την άδειά σας θα θέλαμε να χρησιμοποιήσουμε και προαιρετικά. Μπορείτε να αλλάξετε γνώμη οποιαδήποτε στιγμή.',
    acceptAll: 'Αποδοχή όλων',
    rejectOptional: 'Απόρριψη προαιρετικών',
    choose: 'Επιλογή',
    save: 'Αποθήκευση επιλογών',
    alwaysOn: 'πάντα ενεργό',
    reopen: 'Ρυθμίσεις cookies',
    categories: {
      necessary: {
        label: 'Απολύτως απαραίτητα',
        description: 'Απαραίτητα για τη λειτουργία του ιστότοπου: σύνδεση, ασφάλεια και το καλάθι σας. Δεν απενεργοποιούνται.',
      },
      preferences: {
        label: 'Προτιμήσεις',
        description: 'Θυμούνται επιλογές σας, όπως τη γλώσσα, ώστε να μην τις ξαναρυθμίζετε.',
      },
      analytics: {
        label: 'Στατιστικά',
        description: 'Μας βοηθούν να καταλάβουμε πώς χρησιμοποιείται ο ιστότοπος — ποιες σελίδες διαβάζονται, από πού έρχονται οι επισκέπτες — ώστε να τον βελτιώνουμε. Τα δεδομένα είναι συγκεντρωτικά.',
      },
      marketing: {
        label: 'Διαφήμιση',
        description: 'Επιτρέπει σε διαφημιστικές πλατφόρμες να μετρούν αν οι διαφημίσεις τους σας έφεραν εδώ και να σας δείχνουν πιο σχετικές διαφημίσεις αλλού.',
      },
    },
  },
  de: {
    title: 'Ihre Privatsphäre',
    body: 'Wir verwenden unbedingt erforderliche Cookies für den Betrieb dieser Website. Mit Ihrer Erlaubnis würden wir gern auch optionale verwenden. Sie können Ihre Meinung jederzeit ändern.',
    acceptAll: 'Alle akzeptieren',
    rejectOptional: 'Optionale ablehnen',
    choose: 'Auswählen',
    save: 'Auswahl speichern',
    alwaysOn: 'immer aktiv',
    reopen: 'Cookie-Einstellungen',
    categories: {
      necessary: {
        label: 'Unbedingt erforderlich',
        description: 'Erforderlich für den Betrieb der Website: Anmeldung, Sicherheit und Ihr Warenkorb. Diese lassen sich nicht abschalten.',
      },
      preferences: {
        label: 'Präferenzen',
        description: 'Merkt sich Ihre Entscheidungen, etwa die Sprache, damit Sie sie nicht erneut festlegen müssen.',
      },
      analytics: {
        label: 'Statistik',
        description: 'Hilft uns zu verstehen, wie die Website genutzt wird — welche Seiten gelesen werden, woher Besucher kommen — damit wir sie verbessern können. Die Daten sind aggregiert.',
      },
      marketing: {
        label: 'Marketing',
        description: 'Erlaubt Werbeplattformen zu messen, ob ihre Anzeigen Sie hierher gebracht haben, und Ihnen anderswo relevantere Werbung zu zeigen.',
      },
    },
  },
};


export function isConsentCategory(v: unknown): v is ConsentCategory {
  return typeof v === 'string' && (CONSENT_CATEGORIES as readonly string[]).includes(v);
}

/** Serialise for the cookie. Compact — it rides on every request. */
export function encodeConsent(record: ConsentRecord): string {
  return JSON.stringify({ v: record.v, t: record.t, granted: record.granted });
}

/**
 * Parse a stored cookie value.
 *
 * Returns null for anything absent, malformed, stale, or from an older version.
 * Null means "ask again", and the caller treats it as consent to nothing —
 * failing closed is the only safe direction here.
 */
export function decodeConsent(raw: string | null | undefined, nowMs: number): ConsentRecord | null {
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.v !== CONSENT_VERSION) return null; // categories changed → re-ask

  const t = Number(parsed.t);
  if (!Number.isFinite(t) || t <= 0) return null;
  const ageDays = (nowMs - t) / 86_400_000;
  // A future-dated record means a tampered cookie or a badly skewed clock;
  // either way it is not evidence of a choice this visitor made.
  if (ageDays < 0 || ageDays > CONSENT_MAX_AGE_DAYS) return null;

  const granted = Array.isArray(parsed.granted) ? parsed.granted.filter(isConsentCategory) : [];
  return { v: CONSENT_VERSION, t, granted: normaliseGrants(granted) };
}

/** `necessary` is always granted; unknown or duplicate entries are dropped. */
export function normaliseGrants(granted: readonly unknown[]): ConsentCategory[] {
  const set = new Set<ConsentCategory>(['necessary']);
  for (const g of granted) {
    if (isConsentCategory(g) && g !== 'necessary') set.add(g);
  }
  return CONSENT_CATEGORIES.filter((c) => set.has(c));
}

/**
 * May we run something in `category`?
 *
 * A null record — no cookie, expired, tampered, or superseded — grants nothing
 * except `necessary`. This is the function that makes "prior consent" true
 * rather than aspirational.
 */
export function hasConsent(record: ConsentRecord | null, category: ConsentCategory): boolean {
  if (category === 'necessary') return true;
  if (!record) return false;
  return record.granted.includes(category);
}

/** Record for "accept all". */
export function grantAll(nowMs: number): ConsentRecord {
  return { v: CONSENT_VERSION, t: nowMs, granted: [...CONSENT_CATEGORIES] };
}

/**
 * Record for "reject all".
 *
 * Note this still WRITES a record. Rejecting has to be remembered, or the
 * banner reappears on every page and effectively punishes the visitor for
 * saying no — which is itself a dark pattern.
 */
export function denyAll(nowMs: number): ConsentRecord {
  return { v: CONSENT_VERSION, t: nowMs, granted: ['necessary'] };
}

/** Record from an explicit per-category selection. */
export function grantSelected(nowMs: number, categories: readonly unknown[]): ConsentRecord {
  return { v: CONSENT_VERSION, t: nowMs, granted: normaliseGrants(categories) };
}

/* ------------------------------------------------------------------ *
 * Google Consent Mode v2                                              *
 * ------------------------------------------------------------------ */

/**
 * The signal names Google reads.
 *
 * `ad_user_data` and `ad_personalization` are the two v2 added in March 2024;
 * a site that sends only the v1 three is non-compliant for EEA ad traffic and
 * Google will say so in the console rather than in the browser, which is why
 * this is a named list rather than four strings inline somewhere.
 */
export const CONSENT_MODE_SIGNALS = [
  'ad_storage',
  'ad_user_data',
  'ad_personalization',
  'analytics_storage',
  'functionality_storage',
  'personalization_storage',
  'security_storage',
] as const;
export type ConsentModeSignal = (typeof CONSENT_MODE_SIGNALS)[number];

/**
 * Which of this CMS's categories each Google signal depends on.
 *
 * EXPORTED, and the only definition: `/consent.js` ships this same object to
 * the browser rather than restating it. A signal mapped to the wrong category
 * is invisible in a browser — the tag loads, the page works, and either the
 * measurement is silently wrong or the ad account is silently non-compliant —
 * so a second copy is the last thing this should have.
 */
export const CONSENT_MODE_CATEGORY: Record<ConsentModeSignal, ConsentCategory> = {
  ad_storage: 'marketing',
  ad_user_data: 'marketing',
  ad_personalization: 'marketing',
  analytics_storage: 'analytics',
  functionality_storage: 'preferences',
  personalization_storage: 'preferences',
  // Always granted: this is session integrity and fraud prevention, which is
  // what `necessary` means. Reporting it as denied would be a lie that also
  // breaks the tag.
  security_storage: 'necessary',
};

/**
 * The Consent Mode payload for a given decision.
 *
 * PURE, and exported, because this mapping is the whole of Consent Mode and
 * getting one signal wrong is invisible in a browser: the tag loads, the page
 * works, and the measurement is silently wrong or the account is silently
 * non-compliant.
 *
 * `null` — no decision yet — denies everything except security. That is what
 * makes consent PRIOR, and it is also exactly the default state Google expects
 * to receive before a tag loads.
 */
export function consentModeSignals(record: ConsentRecord | null): Record<ConsentModeSignal, 'granted' | 'denied'> {
  const out = {} as Record<ConsentModeSignal, 'granted' | 'denied'>;
  for (const signal of CONSENT_MODE_SIGNALS) {
    out[signal] = hasConsent(record, CONSENT_MODE_CATEGORY[signal]) ? 'granted' : 'denied';
  }
  return out;
}
