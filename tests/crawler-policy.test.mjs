#!/usr/bin/env node
/**
 * Per-crawler policy: the core half of the seam a paid pack plugs into.
 *
 * The properties worth defending:
 *
 *  1. **The kill switch always wins.** `discourage_indexing` short-circuits
 *     before any group, custom rule or plugin contribution is read. A staging
 *     site that stayed indexed because a plugin outranked it would be the worst
 *     possible failure of this feature.
 *  2. **A named group does not lose the managed disallows.** A crawler obeys
 *     exactly ONE group, so an agent given its own group stops seeing the `*`
 *     group's `/admin` and `/api/` rules. Explicitly allowing Googlebot must not
 *     hand it the admin login form.
 *  3. **A named group never merges into the catch-all.** Groups are terminated
 *     by a blank line; get that wrong and `User-agent: GPTBot / Disallow: /`
 *     silently blocks every crawler on the internet.
 *
 * Run with:  node tests/crawler-policy.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const R = await loadTs('src/lib/robots-txt.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const build = (opts) => R.buildRobotsTxt({ origin: 'https://example.com', discourage: false, ...opts });

/* ---------------------------------------------------- policy → groups */
{
  const g = R.policyToGroups({ GPTBot: 'disallow', Googlebot: 'allow', Applebot: 'default', CCBot: 'nonsense' });
  check('a blocked agent becomes a Disallow group',
    g.some((x) => x.agents[0] === 'GPTBot' && x.disallow.includes('/')));
  check('an allowed agent becomes an explicit group',
    g.some((x) => x.agents[0] === 'Googlebot' && x.allow?.includes('/')));
  // "I have not decided" must contribute nothing, so the agent falls to the
  // catch-all rather than being given a group that says nothing.
  check('a DEFAULT agent contributes no group at all',
    !g.some((x) => x.agents[0] === 'Applebot'));
  check('an unrecognised verdict contributes no group either',
    !g.some((x) => x.agents[0] === 'CCBot'));

  check('a token with whitespace is refused — it would break the line',
    R.policyToGroups({ 'Bad Agent': 'disallow' }).length === 0);
  check('a token with a colon is refused',
    R.policyToGroups({ 'Bad:Agent': 'disallow' }).length === 0);
  check('a non-object policy yields nothing', R.policyToGroups('GPTBot') .length === 0);
}

/* ---------------------------------------------------- the file */
{
  const txt = build({ groups: R.policyToGroups({ GPTBot: 'disallow', Googlebot: 'allow' }) });

  check('a blocked crawler gets its own group', /User-agent: GPTBot\nDisallow: \//.test(txt));
  check('the catch-all survives', /User-agent: \*/.test(txt));
  check('the managed disallows survive', txt.includes('Disallow: /admin') && txt.includes('Disallow: /api/'));
  check('the sitemap line survives', txt.includes('Sitemap: https://example.com/sitemap.xml'));

  /*
   * Blocks, found defensively.
   *
   * `?? ''` rather than a bare `.find(...).includes(...)`: the first version of
   * this threw a TypeError when the group separator was removed, so the
   * mutation that merges every group into one produced a CRASH instead of a
   * failed assertion — which reads as a broken test rather than as the bug it
   * had actually caught. A test that cannot fail cleanly cannot be trusted to
   * have failed for the right reason.
   */
  const blockFor = (agent) =>
    txt.split('\n\n').find((b) => b.startsWith(`User-agent: ${agent}`)) ?? '';

  /* PROPERTY 2 — the one that would quietly expose the admin. */
  check('an ALLOWED agent still gets the managed disallows',
    blockFor('Googlebot').includes('Disallow: /admin') && blockFor('Googlebot').includes('Disallow: /api/'));
  check('...while a BLOCKED one does not need them — it is refused everything',
    !blockFor('GPTBot').includes('/admin'));

  /* PROPERTY 3 — a group must not run into the next one. */
  check('a named group is found at all, which means it was terminated',
    blockFor('GPTBot') !== '');
  check('...and does not swallow the catch-all', !blockFor('GPTBot').includes('User-agent: *'));
  check('...so the catch-all is not accidentally blocked',
    !/User-agent: \*\nDisallow: \/\n/.test(txt));
}

/* ---------------------------------------------------- the kill switch wins */
{
  const txt = R.buildRobotsTxt({
    origin: 'https://example.com',
    discourage: true,
    groups: R.policyToGroups({ Googlebot: 'allow' }),
    custom: 'User-agent: Googlebot\nAllow: /',
  });
  check('discourage_indexing emits the blanket disallow', txt.trim() === 'User-agent: *\nDisallow: /');
  check('...and no group survives it, however permissive', !txt.includes('Googlebot'));
  check('...nor any custom rule', !txt.includes('Allow: /'));
  check('...nor even the sitemap line', !txt.includes('Sitemap:'));
}

/* ---------------------------------------------------- rendering one group */
{
  check('an agent with no rules is rendered as unrestricted, explicitly',
    R.renderGroup({ agents: ['Foo'] }) === 'User-agent: Foo\nDisallow:');
  check('a crawl delay is emitted when asked for',
    R.renderGroup({ agents: ['Foo'], disallow: ['/x'], crawlDelay: 10 }).includes('Crawl-delay: 10'));
  check('a group with no agents renders nothing', R.renderGroup({ agents: [] }) === '');
  check('several agents share one group',
    R.renderGroup({ agents: ['A', 'B'], disallow: ['/'] })
      === 'User-agent: A\nUser-agent: B\nDisallow: /');
}

/* ---------------------------------------------------- the seed is honest */
{
  const seed = R.KNOWN_CRAWLERS_SEED;
  check('the seed names the well-known search crawlers',
    seed.some((c) => c.token === 'Googlebot') && seed.some((c) => c.token === 'Bingbot'));
  check('...and the AI ones the question is actually about',
    ['GPTBot', 'ClaudeBot', 'CCBot', 'PerplexityBot', 'Google-Extended']
      .every((t) => seed.some((c) => c.token === t)));
  check('every entry states its purpose, which is what an operator acts on',
    seed.every((c) => ['search', 'ai-training', 'ai-assistant', 'other'].includes(c.purpose)));
  check('every entry has a human label, not just a token',
    seed.every((c) => c.label && c.label !== c.token));
  // The seed must not pretend to be a catalogue — the file says so, and this
  // asserts the claim is written down rather than merely intended.
  const src = await (await import('node:fs/promises')).readFile('src/lib/robots-txt.ts', 'utf8');
  check('the file says plainly that the seed is not exhaustive',
    /SEED, not a catalogue|not exhaustive|WILL go stale/i.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
