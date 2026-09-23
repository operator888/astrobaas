/**
 * `robots.txt`, with an editor behind it (C-3).
 *
 * ## What the operator can and cannot change
 *
 * A shop migrating from Yoast or Rank Math expects to add `Disallow: /search`,
 * block a named AI crawler, or point at a second sitemap. Before this, the only
 * lever was a site-wide on/off switch.
 *
 * So custom rules are APPENDED to a managed block rather than replacing the
 * file. Two reasons, and the second is the one that decides it:
 *
 * 1. `robots.txt` matching is by specificity, not by order, and `Allow` beats
 *    `Disallow` at equal specificity — so appending is not a weaker form of
 *    editing. An operator who wants `/api/openapi.json` crawlable writes
 *    `Allow: /api/openapi.json` and gets it, managed block intact.
 * 2. A full-file editor lets someone delete `Disallow: /admin` by accident and
 *    never find out. Nothing 404s, nothing logs, and the admin login form turns
 *    up in a search index weeks later.
 *
 * ## The kill switch always wins
 *
 * `discourage_indexing` short-circuits before any custom text is read. It is the
 * one setting whose whole purpose is "take this site out of search", and a
 * staging site that stayed indexed because a stray `Allow:` outranked it would
 * be the worst possible failure of this feature. The custom block is not even
 * concatenated in that branch — it cannot be, rather than merely being outranked.
 *
 * ## Sitemap lines
 *
 * The managed `Sitemap:` comes from `resolveSiteUrl`, the same resolver the
 * sitemap, feed and canonical use, so the four cannot name different origins.
 * An operator's own `Sitemap:` line in the custom block is kept — a shop with a
 * separate product feed genuinely needs two — and `Sitemap` is group-independent
 * in the spec, so position does not matter.
 */

/* ══════════════════════════════════════════════════════════════════════════
 * PER-CRAWLER POLICY — the core half of the seam
 *
 * Core owns the MECHANISM: a structured list of user-agent groups, a plugin
 * hook that lets a pack contribute or rewrite them, and an honest hand-modelled
 * implementation the operator drives from the admin.
 *
 * A pack owns the CATALOGUE and the ENFORCEMENT, and both are real work rather
 * than a licence check:
 *
 *  · The catalogue is MAINTAINED DATA. New crawlers appear monthly, tokens get
 *    renamed, one company runs several bots with different purposes, and the
 *    difference between "indexes you" and "trains on you" is not derivable from
 *    the string. That is the same argument the tax rate tables make, and it is
 *    why core seeds a dozen well-known agents and refuses to pretend the list
 *    is complete.
 *  · robots.txt is a REQUEST, not a control. A crawler that ignores it is
 *    exactly the crawler an operator wanted to stop, so actual enforcement
 *    happens in middleware against the User-Agent header — and that needs the
 *    same maintained catalogue plus somewhere to report what was seen.
 *
 * Core therefore ships something genuinely useful on its own (name an agent,
 * choose allow or disallow, it lands in robots.txt) and leaves the parts that
 * need upkeep to a pack. No licence gating, and nothing here degrades if no
 * pack is installed.
 * ═════════════════════════════════════════════════════════════════════════ */

/** What a crawler is FOR. The distinction operators actually want to act on. */
export type CrawlerPurpose =
  /** Builds a search index that sends traffic back. */
  | 'search'
  /** Collects training data for a model. */
  | 'ai-training'
  /** Fetches a page live to answer a user's question, and usually cites it. */
  | 'ai-assistant'
  /** Archives, SEO tools, everything else. */
  | 'other';

export interface KnownCrawler {
  /** The User-agent token, exactly as it appears in robots.txt. */
  token: string;
  label: string;
  purpose: CrawlerPurpose;
  /** Substring matched against the User-Agent HEADER, for enforcement. */
  uaMatch?: string;
}

/**
 * A SEED, not a catalogue.
 *
 * The well-known agents as of writing, so the admin has something to offer on a
 * fresh install and an operator can act without buying anything. It WILL go
 * stale — that is the nature of the list, not a defect in it, and it is exactly
 * why the maintained version is a pack's job rather than a core file somebody
 * remembers to update.
 *
 * Deliberately not exhaustive and deliberately not annotated with claims about
 * what each company does with the data: that changes, it is contested, and a
 * CMS asserting it in a shipped constant would be wrong in public.
 */
export const KNOWN_CRAWLERS_SEED: readonly KnownCrawler[] = [
  { token: 'Googlebot', label: 'Google Search', purpose: 'search', uaMatch: 'Googlebot' },
  { token: 'Bingbot', label: 'Bing', purpose: 'search', uaMatch: 'bingbot' },
  { token: 'DuckDuckBot', label: 'DuckDuckGo', purpose: 'search', uaMatch: 'DuckDuckBot' },
  { token: 'Applebot', label: 'Apple', purpose: 'search', uaMatch: 'Applebot' },
  { token: 'Google-Extended', label: 'Google AI training', purpose: 'ai-training' },
  { token: 'GPTBot', label: 'OpenAI training', purpose: 'ai-training', uaMatch: 'GPTBot' },
  { token: 'ClaudeBot', label: 'Anthropic training', purpose: 'ai-training', uaMatch: 'ClaudeBot' },
  { token: 'anthropic-ai', label: 'Anthropic (legacy token)', purpose: 'ai-training' },
  { token: 'CCBot', label: 'Common Crawl', purpose: 'ai-training', uaMatch: 'CCBot' },
  { token: 'Applebot-Extended', label: 'Apple AI training', purpose: 'ai-training' },
  { token: 'OAI-SearchBot', label: 'OpenAI search', purpose: 'ai-assistant', uaMatch: 'OAI-SearchBot' },
  { token: 'ChatGPT-User', label: 'ChatGPT browsing', purpose: 'ai-assistant', uaMatch: 'ChatGPT-User' },
  { token: 'PerplexityBot', label: 'Perplexity', purpose: 'ai-assistant', uaMatch: 'PerplexityBot' },
  { token: 'Claude-Web', label: 'Claude browsing', purpose: 'ai-assistant' },
];

/** One `User-agent:` group in the generated file. */
export interface RobotsGroup {
  /** One or more tokens. `['*']` is the catch-all group. */
  agents: string[];
  allow?: string[];
  disallow?: string[];
  /** Seconds. Honoured by some crawlers, ignored by Google. */
  crawlDelay?: number;
  /** Who contributed it — 'managed', 'operator', or a plugin id. For the admin. */
  source?: string;
}

/** The setting an operator's per-agent choices are stored under. */
export const CRAWLER_POLICY_SETTING = 'crawler_policy';

/**
 * Turn the operator's stored choices into groups.
 *
 * The stored shape is deliberately tiny — `{ "GPTBot": "disallow" }` — because
 * it is what a checkbox column produces and what a pack can extend without
 * migrating anything. `'allow'` emits an explicit empty-Disallow group, which
 * is the documented way to say "this agent may crawl everything" and is worth
 * emitting rather than omitting: it makes the operator's intent visible in the
 * file rather than implied by absence.
 */
export function policyToGroups(raw: unknown): RobotsGroup[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: RobotsGroup[] = [];
  for (const [token, verdict] of Object.entries(raw as Record<string, unknown>)) {
    const t = String(token).trim();
    // A token with whitespace or a colon would break the line it is written on.
    if (!t || /[\s:]/.test(t)) continue;
    if (verdict === 'disallow') out.push({ agents: [t], disallow: ['/'], source: 'operator' });
    else if (verdict === 'allow') out.push({ agents: [t], disallow: [], allow: ['/'], source: 'operator' });
    // Anything else — including 'default' — contributes no group at all, which
    // leaves the agent governed by the catch-all. That is the right meaning of
    // "I have not decided about this one".
  }
  return out;
}

/** Render one group. Exported so a pack can preview exactly what it will emit. */
export function renderGroup(g: RobotsGroup): string {
  const lines = g.agents.filter(Boolean).map((a) => `User-agent: ${a}`);
  if (!lines.length) return '';
  for (const p of g.allow ?? []) lines.push(`Allow: ${p}`);
  for (const p of g.disallow ?? []) lines.push(`Disallow: ${p}`);
  // An agent named with NO rule at all is a group a crawler reads as "no
  // restrictions", which is a legitimate thing to say explicitly.
  if (!(g.allow ?? []).length && !(g.disallow ?? []).length) lines.push('Disallow:');
  if (typeof g.crawlDelay === 'number' && g.crawlDelay > 0) {
    lines.push(`Crawl-delay: ${Math.round(g.crawlDelay)}`);
  }
  return lines.join('\n');
}

/** Hard ceiling on the stored body. Google stops reading a robots.txt at 500 KB. */
export const MAX_ROBOTS_BYTES = 32 * 1024;

/**
 * Lines the managed block always contains.
 *
 * Not access control — `robots.txt` is a request, and the admin is protected by
 * sessions rather than by politeness. It is here so a well-behaved crawler does
 * not spend the site's budget on pages it cannot use, and so the login form does
 * not end up in an index.
 */
const MANAGED_DISALLOW = ['/admin', '/api/'] as const;

export interface RobotsOptions {
  /** The operator's own rules, from the `robots_txt` setting. */
  custom?: unknown;
  /** `discourage_indexing`. When true, nothing else is emitted. */
  discourage: boolean;
  /** Absolute origin for the Sitemap line, already resolved. */
  origin: string;
  /**
   * Per-agent groups, from the operator's policy and from any pack that
   * contributed through the ROBOTS_GROUPS filter.
   *
   * Emitted BEFORE the catch-all `*` group. Order does not decide precedence in
   * robots.txt — a crawler picks the most specific group that names it — but
   * putting the named ones first makes the file readable by the human who has
   * to audit it, and that is the only reader whose ordering intuition matters.
   */
  groups?: RobotsGroup[];
}

/**
 * Normalise a stored robots body.
 *
 * Exported because the settings validator and the renderer must agree on what
 * is acceptable: a value the validator accepts and the renderer strips would
 * show the operator a saved rule that never reaches the file.
 *
 * - CRLF and lone CR both become LF. A body pasted from a Windows editor would
 *   otherwise carry `\r` into the response, and `Disallow: /search\r` is a rule
 *   about a path ending in a carriage return.
 * - Other C0 control characters are removed rather than escaped; none of them
 *   are meaningful in this format and a NUL would truncate the file for some
 *   readers.
 * - Trailing whitespace per line goes, because `Disallow: /admin ` and
 *   `Disallow: /admin` are different rules and the difference is invisible.
 */
export function normaliseRobotsBody(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

/**
 * Why a stored robots body is unusable, or null when it is fine.
 *
 * Deliberately permissive about CONTENT. `robots.txt` has a long tail of
 * vendor-specific directives (`Crawl-delay`, `Clean-param`, `Host`) and new ones
 * appear whenever a crawler does; a validator that only allowed the directives
 * someone thought of would reject the exact line an operator came here to add.
 * So this checks size and characters, not vocabulary.
 */
export function validateRobotsBody(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return 'must be text';
  if (Buffer.byteLength(raw, 'utf8') > MAX_ROBOTS_BYTES) {
    return `must be under ${Math.round(MAX_ROBOTS_BYTES / 1024)} KB`;
  }
  // A `<` here almost always means somebody pasted HTML — the page source of
  // their old site, or an error page. Serving that as robots.txt makes every
  // rule in it invisible, so it is worth refusing rather than accepting.
  if (/<\s*(html|!doctype|script|body)\b/i.test(raw)) {
    return 'looks like HTML rather than robots.txt rules';
  }
  return null;
}

/**
 * Build the file.
 *
 * Pure: no settings read, no database. The route passes what it already has,
 * which is also what makes this testable without a running server.
 */
/**
 * Does this body open a `User-agent` group of its own?
 *
 * Comments and blank lines above it do not count as content, so a body that
 * starts with `# block the AI crawlers` and then `User-agent: GPTBot` is still
 * a group opener.
 */
function startsWithGroup(body: string): boolean {
  for (const line of body.split('\n')) {
    const l = line.trim();
    if (l === '' || l.startsWith('#')) continue;
    return /^user-agent\s*:/i.test(l);
  }
  return false;
}

export function buildRobotsTxt(opts: RobotsOptions): string {
  if (opts.discourage) {
    // Nothing else. Not the managed block, not the custom rules, not the
    // Sitemap line — a sitemap on a site asking not to be indexed is a
    // contradiction that invites a crawler to resolve it the wrong way.
    return 'User-agent: *\nDisallow: /\n';
  }

  const custom = normaliseRobotsBody(opts.custom);
  const managed = [
    'User-agent: *',
    ...MANAGED_DISALLOW.map((p) => `Disallow: ${p}`),
  ].join('\n');

  /*
   * Named agents first, then the catch-all.
   *
   * Each group is separated by a BLANK LINE, which is what terminates a group
   * in the format. Without it `User-agent: GPTBot / Disallow: /` would run into
   * the `*` group and block every crawler on the internet — the same trap the
   * custom-body handling below documents, and the reason both go through the
   * same care.
   *
   * The managed `/admin` and `/api/` disallows are NOT repeated into each named
   * group. A crawler obeys exactly one group, so an agent with its own group
   * stops seeing them — which is correct when that group says `Disallow: /`,
   * and a real gap when it says allow. So an explicitly-allowed agent inherits
   * the managed disallows here rather than being handed the whole site.
   */
  const namedGroups = (opts.groups ?? [])
    .filter((g) => g.agents?.length && !g.agents.includes('*'))
    .map((g) => renderGroup(
      (g.disallow ?? []).includes('/')
        ? g
        : { ...g, disallow: [...new Set([...(g.disallow ?? []), ...MANAGED_DISALLOW])] },
    ))
    .filter(Boolean);

  const parts: (string | null)[] = [];
  for (const g of namedGroups) parts.push(g, '');
  parts.push(managed);
  if (custom) {
    // Whether a blank line goes between them depends on what the operator
    // wrote, and getting this backwards silently discards their rules.
    //
    // A `User-agent` group ENDS at a blank line. So:
    //
    //   · a custom body that starts with its own `User-agent:` needs the blank
    //     line, or `User-agent: GPTBot / Disallow: /` merges into the managed
    //     `*` group and blocks every crawler on the internet;
    //   · a custom body of BARE directives — `Disallow: /search`, which is what
    //     someone migrating from Yoast types — must NOT have one, or it lands
    //     after the group terminator, belongs to no group at all, and is
    //     ignored by every crawler while looking perfectly correct in the file.
    //
    // A mixed body (bare rules, blank line, then a `User-agent:`) works under
    // this rule too: the first part joins the managed group and the rest opens
    // its own, which is what the author wrote and what they meant.
    parts.push(startsWithGroup(custom) ? '' : null, custom);
  }
  parts.push('', `Sitemap: ${opts.origin.replace(/\/$/, '')}/sitemap.xml`);

  return `${parts.filter((p) => p !== null).join('\n')}\n`;
}
