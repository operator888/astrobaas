/**
 * What needs your attention — the dashboard doing work instead of decorating.
 *
 * ## The idea
 *
 * This admin already KNOWS a great deal that nobody sees: a tax origin country
 * that was never set, a migration that wrote a report, orders the risk scorer
 * flagged and nobody opened, a brand spelled four ways. Each of those lives in
 * a screen someone has to think to visit.
 *
 * So: every card here is derived from a check the system genuinely performs,
 * and disappears when the underlying fact stops being true. Nothing is invented
 * to fill space, and there is no card whose purpose is engagement.
 *
 * ## Three kinds, which behave differently
 *
 * `broken`        Something is wrong NOW. Not dismissible — dismissing a real
 *                 fault is how faults get forgotten. It leaves when it is fixed.
 * `unfinished`    Configuration started and not completed, or a threshold
 *                 crossed. Dismissible: the operator may genuinely not want it.
 * `worth-knowing` Advice. Dismissible and unimportant.
 *
 * ## Dismissal is a SEAM, not yet a feature
 *
 * `runAttention` accepts a `dismissed` list and honours it, and the rules
 * around it are settled and tested. **No UI reaches it yet**: the dashboard
 * passes nothing and renders no dismiss control, so today every card stays
 * until the fact behind it stops being true.
 *
 * Said plainly because the alternative is a reader assuming otherwise. What is
 * missing is the storage decision, and it is a real one: a `shop`-scoped
 * dismissal belongs in settings and a `user`-scoped one on the user record, and
 * putting both in the wrong place is worse than not having either — one person
 * would put a card away and it would vanish for a colleague who needed it.
 *
 * ## Two rules that keep it from becoming noise
 *
 *  1. **A card must name an action and a destination.** If there is nothing to
 *     click, it is a report, not a card — the type makes this unskippable.
 *  2. **A broken card ages UPWARD.** Something ignored for two weeks is more
 *     urgent, not less. That is the opposite of a normal feed, and it is why
 *     `rankAttention` sorts by age ascending within a severity rather than
 *     newest-first.
 *
 * ## Cost
 *
 * Every check here is PURE and runs over rows the dashboard has already loaded.
 * That is deliberate: the dashboard reads six tables to compute four numbers,
 * and it is the screen an operator opens most. A check that issued its own
 * query would make the most-visited page the slowest one.
 *
 * When a check needs something genuinely expensive — alt-text coverage across
 * every media row, say — it belongs behind the cache layer with a TTL, not
 * here. `AttentionContext` is the boundary: if a fact is not on it, the check
 * cannot see it, and adding a field is a deliberate act with a visible cost.
 */

import { canOpenAdminPage } from '../admin-access';
import { TAX_KEYS } from '../commerce/tax';
import type { Role } from '../../core/models';

export type Severity = 'broken' | 'unfinished' | 'worth-knowing';

export interface AttentionCard {
  /**
   * Stable across deploys and across restarts.
   *
   * Dismissal is keyed on this, so an id derived from a timestamp or an array
   * index would resurrect a dismissed card on the next boot — or, worse, hide
   * a different card that happened to land on the same index.
   */
  id: string;
  severity: Severity;
  /**
   * What a card SAYS is not stored here.
   *
   * Every card's text is three translation keys derived mechanically from its
   * id — `admin.attention.<id>.title`, `.body` and `.action` — because the
   * first version carried English string literals and shipped an English
   * dashboard to a Greek admin. The locale guard did not catch it: that guard
   * scans for literal translate-call sites, and a bare string in a data
   * structure is
   * not a call site.
   *
   * Deriving the keys rather than storing them means a check cannot be written
   * with text and no translation — there is nowhere to put the text.
   * `tests/attention.test.mjs` asserts all three keys exist in all three
   * locales for every registered check.
   */
  params?: Record<string, string | number>;
  /** REQUIRED. A card with nowhere to go is a report, not a card. */
  action: { href: string };
  /**
   * When the underlying fact became true, ISO. Optional because some facts have
   * no date — "tax is not configured" has always been true. Absent sorts as
   * "unknown age", after the dated ones, rather than as "just now".
   */
  since?: string;
  /**
   * Who a dismissal applies to.
   *
   * `shop` for configuration — if the admin sets the origin country, the editor
   * should stop being told about it. `user` for advice, which is a matter of
   * personal preference. Mixing the two silently is baffling to use: one person
   * dismisses a card and it vanishes for a colleague who needed it.
   *
   * `broken` cards are never dismissible, so this is meaningless on them.
   */
  scope: 'shop' | 'user';
}

/** Everything a check may look at. Nothing here triggers a query. */
export interface AttentionContext {
  /** Resolved settings, key -> value, as the dashboard already loads them. */
  settings: Record<string, unknown>;
  /** Schema version the storage reports, and the version this build expects. */
  schema?: { current: number; latest: number };
  products?: readonly {
    id: string; status?: string; in_stock?: boolean; name?: string;
  }[];
  orders?: readonly {
    id: string; number?: string; status?: string;
    risk_flagged?: boolean; created_at?: string;
    /** Placed on hold by the opt-in risk hold (S4.15). */
    risk_held?: boolean;
    /** Paid after it was cancelled, stock gone: money to send back (S4.3). */
    needs_refund?: boolean;
    needs_refund_at?: string;
  }[];
  /**
   * Where payment providers send a paying buyer back to, as judged by
   * payments/return-url-check.ts — the verdict /api/health/deep reports.
   * Computed by the dashboard (it needs the environment); absent means
   * "not checked", never "fine".
   */
  paymentReturnUrls?: { status: 'ok' | 'warn' };
  posts?: readonly {
    id: string; title?: string; status?: string; publish_date?: string;
  }[];
  /** Whether commerce is on at all — half these checks are meaningless without it. */
  commerceEnabled?: boolean;
  /**
   * Astro's own `site`, i.e. the build-time `SITE_URL`.
   *
   * Passed in rather than read, because this module is pure. It is the second
   * step of `lib/site-url.ts`'s precedence and the shape most production
   * deployments actually use.
   */
  buildSiteUrl?: string | null;
  /** Injected so "overdue" is testable without waiting. */
  nowMs?: number;
  /**
   * Who is looking.
   *
   * REQUIRED in practice: a card is only shown to someone who could act on it,
   * and absent means nobody. See the filter in `runAttention`.
   */
  role?: Role;
}

export interface AttentionCheck {
  id: string;
  /** Returns any number of cards, or none. Must never throw — see `runAttention`. */
  run: (ctx: AttentionContext) => AttentionCard[];
}

/* ------------------------------------------------------------------ helpers */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * A setting that is genuinely absent.
 *
 * Absent, null, or a string that is empty once trimmed — the last being "the
 * operator opened the field and saved it blank".
 *
 * The string "false" is NOT absent, and an earlier version of this comment
 * claimed it was. It matters that the two are different: `tax_enabled: 'false'`
 * means the operator turned tax off, which is a decision, while an absent
 * `shop_country` means nobody has said. Treating a decision as an absence is
 * how a check starts nagging about something already settled.
 */
const unset = (v: unknown): boolean => v === undefined || v === null || str(v) === '';

/* ------------------------------------------------------------------- checks */

export const ATTENTION_CHECKS: readonly AttentionCheck[] = [
  {
    /*
     * The address of this CMS.
     *
     * Broken rather than unfinished: absent, every canonical tag, sitemap URL
     * and emailed link is built from a guess. The deep health check already
     * warns about it — in a place an operator visits when something is
     * *already* wrong.
     */
    id: 'site-url-unset',
    run: (ctx) => {
      // The BUILD-TIME address counts. `lib/site-url.ts` resolves in order:
      // the `site_url` setting, then Astro's `site` (from `SITE_URL` at build),
      // then the request's own origin. The first version of this check looked
      // only at the settings row — so the ordinary production shape, where an
      // operator sets SITE_URL in the environment and never opens the settings
      // screen, was reported as broken forever. A permanent false alarm is how
      // an operator learns to ignore this whole panel.
      if (!unset(ctx.settings.site_url) || !unset(ctx.settings.public_site_url)) return [];
      if (!unset(ctx.buildSiteUrl)) return [];
      return [{ id: 'site-url-unset', severity: 'broken', action: { href: '/admin/settings' }, scope: 'shop' }];
    },
  },
  {
    /*
     * Tax origin — the seller's own country.
     *
     * The KEY is `shop_country`, from `TAX_KEYS.originCountry`. The first
     * version of this check read `tax_origin_country`, a key this codebase does
     * not have and no writer produces — so `unset()` was true forever and the
     * card fired permanently on every correctly configured shop with tax
     * switched on. A card that cries wolf is worse than no card, and inventing
     * a key is the thing this codebase says loudest not to do.
     *
     * `TAX_KEYS` is imported rather than the string retyped, so the reader and
     * the tax engine cannot drift the way this already did once.
     */
    id: 'tax-origin-unset',
    run: (ctx) => {
      const enabled = ctx.settings[TAX_KEYS.enabled];
      const on = enabled === true || str(enabled).toLowerCase() === 'true';
      if (!on || !unset(ctx.settings[TAX_KEYS.originCountry])) return [];
      return [{ id: 'tax-origin-unset', severity: 'broken', action: { href: '/admin/settings' }, scope: 'shop' }];
    },
  },
  {
    /*
     * A schema older than the code reading it.
     *
     * Migrations run at boot, so this normally cannot happen — which is exactly
     * why it is worth saying loudly when it does.
     */
    id: 'schema-behind',
    run: (ctx) => (ctx.schema && ctx.schema.current < ctx.schema.latest
      ? [{
        id: 'schema-behind',
        severity: 'broken',
        params: { current: ctx.schema.current, latest: ctx.schema.latest },
        action: { href: '/admin/operations' },
        scope: 'shop',
      }]
      : []),
  },
  {
    /*
     * Orders the risk scorer flagged and nobody opened.
     *
     * The scorer refuses nothing by design — a flagged order is PLACED and
     * flagged, because refusing means the best order of the month silently
     * vanishes. That design only works if somebody looks, and until now nothing
     * asked them to.
     */
    id: 'flagged-orders',
    run: (ctx) => {
      if (!ctx.commerceEnabled) return [];
      // `on-hold` only when the RISK hold put it there (S4.15): those are
      // exactly the flagged orders waiting for a person. A hold a person made
      // is already in someone's hands.
      const flagged = (ctx.orders ?? []).filter(
        (o) => o.risk_flagged === true
          && (o.status === 'pending' || o.status === 'processing' || (o.status === 'on-hold' && o.risk_held === true)),
      );
      if (!flagged.length) return [];
      // The OLDEST, because that is the one that has been waiting.
      const since = flagged
        .map((o) => o.created_at)
        .filter((d): d is string => typeof d === 'string')
        .sort()[0];
      return [{
        id: 'flagged-orders',
        severity: 'unfinished',
        params: { count: flagged.length },
        action: { href: '/admin/orders' },
        since,
        scope: 'shop',
      }];
    },
  },
  {
    /*
     * Money that has to go back (S4.3).
     *
     * The provider reported a payment for an order the shop had already
     * cancelled, and its stock had been sold to someone else, so the order
     * could not be reopened. It stays cancelled, `needs_refund` is set, and
     * the owner is emailed once — but an email is easy to miss, and this is a
     * customer who has paid for nothing.
     *
     * `broken`, so it cannot be put away: it leaves when the refund is made
     * (a full refund clears the flag). Aged from when the flag was set, which
     * is when the customer started waiting.
     */
    id: 'orders-need-refund',
    run: (ctx) => {
      if (!ctx.commerceEnabled) return [];
      const owed = (ctx.orders ?? []).filter((o) => o.needs_refund === true);
      if (!owed.length) return [];
      const since = owed
        .map((o) => o.needs_refund_at ?? o.created_at)
        .filter((d): d is string => typeof d === 'string')
        .sort()[0];
      return [{
        id: 'orders-need-refund',
        severity: 'broken',
        params: { count: owed.length },
        action: { href: '/admin/orders' },
        since,
        scope: 'shop',
      }];
    },
  },
  {
    /*
     * Payment providers would send paying buyers to a page that does not
     * exist (S4.17).
     *
     * The CMS serves no /checkout/success page; on a headless shop the
     * storefront does, and the Site URL setting is how the providers find it.
     * The verdict comes from the same pure function /api/health/deep uses, so
     * the two can never disagree. `unfinished`, as the health check keeps it a
     * warning: it is configuration, not a broken CMS.
     */
    id: 'payment-return-urls',
    run: (ctx) => {
      if (!ctx.commerceEnabled || ctx.paymentReturnUrls?.status !== 'warn') return [];
      return [{
        id: 'payment-return-urls',
        severity: 'unfinished',
        action: { href: '/admin/settings' },
        scope: 'shop',
      }];
    },
  },
  {
    /*
     * Products on sale that cannot be sold.
     *
     * `worth-knowing`, not `unfinished`: a shop may deliberately list something
     * out of stock to take backorders, so this is context rather than an
     * unfinished job. An earlier comment here said "unfinished" while the code
     * said otherwise — severity decides dismissibility AND ordering, so the two
     * disagreeing is not cosmetic.
     */
    id: 'active-out-of-stock',
    run: (ctx) => {
      if (!ctx.commerceEnabled) return [];
      const stuck = (ctx.products ?? []).filter(
        (p) => p.status === 'active' && p.in_stock === false,
      );
      if (!stuck.length) return [];
      return [{
        id: 'active-out-of-stock',
        severity: 'worth-knowing',
        params: { count: stuck.length },
        action: { href: '/admin/products' },
        scope: 'user',
      }];
    },
  },
  {
    /*
     * A scheduled post whose moment has passed.
     *
     * The scheduler runs on a timer; a post still sitting in `scheduled` with a
     * date in the past means the timer did not fire, and the author believes it
     * published.
     */
    id: 'overdue-scheduled-posts',
    run: (ctx) => {
      const now = ctx.nowMs ?? Date.now();
      const overdue = (ctx.posts ?? []).filter((p) => {
        if (p.status !== 'scheduled' || typeof p.publish_date !== 'string') return false;
        const at = Date.parse(p.publish_date);
        return Number.isFinite(at) && at < now;
      });
      if (!overdue.length) return [];
      const since = overdue
        .map((p) => p.publish_date)
        .filter((d): d is string => typeof d === 'string')
        .sort()[0];
      return [{
        id: 'overdue-scheduled-posts',
        severity: 'broken',
        params: { count: overdue.length },
        action: { href: '/admin/posts' },
        since,
        scope: 'shop',
      }];
    },
  },
  {
    /*
     * The brand-spelling report migration v15 leaves behind.
     *
     * Written by a migration, which has no UI and no other way to reach an
     * operator. Without this card it is a settings row nobody will ever read.
     */
    id: 'brand-spellings',
    run: (ctx) => {
      // Gated like its siblings. A brand is a catalogue concept, so on a shop
      // with commerce off the card would point at /admin/products — a screen
      // the sidebar deliberately hides there. In practice the report only
      // exists where products do, but relying on that leaves the reader to work
      // it out; the guard says it.
      if (!ctx.commerceEnabled) return [];
      const report = ctx.settings.brand_spelling_report as
        { needs_a_human?: unknown[]; possibly_related?: unknown[] } | undefined;
      if (!report || typeof report !== 'object') return [];
      const open = (report.needs_a_human?.length ?? 0) + (report.possibly_related?.length ?? 0);
      if (!open) return [];
      return [{
        id: 'brand-spellings',
        severity: 'worth-knowing',
        params: { count: open },
        action: { href: '/admin/products' },
        scope: 'user',
      }];
    },
  },
  {
    /*
     * The assistant's last provider failure.
     *
     * An OBJECT — `AssistantErrorRecord` from lib/ai-assistant.ts, written by
     * the chat route as `{ at, status, detail, provider, model }`. The first
     * version of this check ran it through a string helper, which returns ''
     * for an object, so the check was DEAD and could never fire. `detail` is
     * documented there as redacted and never carries a credential.
     *
     * Already rendered as a panel on the settings screen — a screen nobody
     * opens unless they already suspect something, which is how a key that
     * stopped working goes unnoticed for weeks.
     */
    id: 'assistant-error',
    run: (ctx) => {
      const rec = ctx.settings.assistant_last_error as
        { at?: string; status?: number; detail?: string; provider?: string } | undefined;
      if (!rec || typeof rec !== 'object') return [];
      const detail = str(rec.detail);
      if (!detail) return [];
      return [{
        id: 'assistant-error',
        severity: 'unfinished',
        params: {
          detail: detail.slice(0, 160),
          provider: str(rec.provider) || '—',
          status: typeof rec.status === 'number' ? rec.status : 0,
        },
        action: { href: '/admin/settings' },
        // The record carries its own timestamp, so this card ages honestly.
        since: str(rec.at) || undefined,
        scope: 'shop',
      }];
    },
  },
];

/* ------------------------------------------------------------------ running */

const SEVERITY_RANK: Record<Severity, number> = {
  broken: 0,
  unfinished: 1,
  'worth-knowing': 2,
};

/** A card an operator can still put away. `broken` never qualifies. */
export function isDismissible(card: AttentionCard): boolean {
  return card.severity !== 'broken';
}

/**
 * Severity first, then AGE — oldest first.
 *
 * The age direction is the deliberate part. A normal feed puts the newest thing
 * on top; a list of faults should put the one that has been ignored longest on
 * top, because that is the one going wrong quietly. A card with no date sorts
 * last within its severity: unknown age is not the same claim as "just now".
 */
export function rankAttention(cards: readonly AttentionCard[]): AttentionCard[] {
  return [...cards].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    if (a.since && b.since) return a.since.localeCompare(b.since);
    if (a.since) return -1;
    if (b.since) return 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Run every check and rank what comes back.
 *
 * A check that THROWS is skipped, not fatal. This renders on the screen an
 * operator opens most, and a dashboard that 500s because one advisory check hit
 * an unexpected row shape is a worse outcome than a dashboard missing one card
 * — the same reasoning `PublicHeader` uses when it hides the theme toggle
 * rather than failing the header.
 */
export function runAttention(
  ctx: AttentionContext,
  opts: { dismissed?: readonly string[]; checks?: readonly AttentionCheck[] } = {},
): AttentionCard[] {
  const dismissed = new Set(opts.dismissed ?? []);
  const cards: AttentionCard[] = [];
  for (const check of opts.checks ?? ATTENTION_CHECKS) {
    try {
      for (const card of check.run(ctx) ?? []) {
        /*
         * A card is shown only to someone who can OPEN what it points at.
         *
         * `/admin` is open to every staff role, so without this an AUTHOR saw
         * seven of eight cards — every one of them linking to a screen the
         * middleware would bounce them from, and two of them carrying
         * information the role boundary exists to withhold: the provider's raw
         * error text, which can contain a fragment of an API key, and how many
         * orders the risk scorer flagged.
         *
         * Keyed on the card's own destination through `canOpenAdminPage` —
         * the same function the sidebar, the palette and the middleware use —
         * rather than a per-card list of roles. A list would be a second place
         * to state a rule that already exists, and it would go stale the first
         * time a screen's roles changed. This way a card added later is
         * governed automatically by where it points.
         *
         * Fails CLOSED: no role means no cards.
         */
        if (!canOpenAdminPage(card.action.href, ctx.role)) continue;
        // A dismissal can never hide a fault. Something that was put away and
        // then came back is the case dismissal must not swallow, and a `broken`
        // card is exactly that case.
        if (dismissed.has(card.id) && isDismissible(card)) continue;
        cards.push(card);
      }
    } catch {
      /* one advisory check must not take the dashboard down */
    }
  }
  return rankAttention(cards);
}
