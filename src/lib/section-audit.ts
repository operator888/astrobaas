/**
 * What is actually in stored content, and what this build can still style.
 *
 * Sections are CSS classes in saved HTML. That is what makes them cheap — no
 * second document model, no renderer upstream of production — and it is also
 * the one thing that can rot: the vocabulary lives in code and the content
 * lives in the database, and code ships more often than content is rewritten.
 *
 * Three ways they drift apart, all silent:
 *
 *  1. **A section is removed or renamed.** Published pages still carry
 *     `ab-oldthing`. The sanitizer strips it on the next save, so the layout
 *     survives right up until someone edits the page for an unrelated reason —
 *     and then quietly collapses.
 *  2. **A theme ships a pattern using a class this build does not define.**
 *     Inserting it appears to work and loses a region on save.
 *  3. **Content predates sections entirely**, carrying classes from a hand-
 *     written import that were never in any vocabulary.
 *
 * None of these throw. None appear in logs. So this reports them, on demand,
 * against real stored rows — a read-only audit that changes nothing.
 *
 * It deliberately does NOT auto-repair. Rewriting stored content to match a
 * code change is exactly the kind of well-meant migration that loses an
 * author's work, and the correct fix (restore the section, or edit the page) is
 * a judgement call.
 */
import type { Post } from '../core/models';
import { sectionClassList, SECTION_PREFIX, SECTIONS, isPluginSectionClass } from '../core/sections';
import { articlesOnly, pagesOnly } from './post-kind';

export interface AuditRow {
  id: string;
  title: string;
  slug: string;
  kind: 'post' | 'page';
  status: string;
  /** `ab-` classes this build cannot style AND would strip on the next save. */
  unknownClasses: string[];
  /**
   * Plugin classes whose plugin is not currently installed or active.
   *
   * Kept apart from `unknownClasses` because the remedy and the urgency are
   * different: these are NOT at risk — the sanitizer preserves the whole
   * `ab-x-*` namespace by shape — they are simply unstyled until the plugin
   * comes back. Reporting them as "will be stripped" would send someone
   * rewriting pages that need nothing done to them.
   */
  orphanedPluginClasses: string[];
}

export interface SectionAudit {
  /** Rows carrying at least one unrecognised `ab-` class. */
  affected: AuditRow[];
  /** Every unrecognised class, with how many records carry it. */
  unknownTotals: { className: string; records: number }[];
  /** Plugin classes with no installed plugin behind them. */
  orphanedTotals: { className: string; records: number }[];
  /** How many stored records use sections at all — context for the numbers. */
  usingSections: number;
  scanned: number;
  /** Section name → how many records use it. Shows what is worth keeping. */
  usage: { name: string; records: number }[];
}

/**
 * Every class on an element, from raw HTML.
 *
 * A regex rather than a DOM parse: this runs server-side over potentially every
 * row, the input has already been through the sanitizer, and we are reading
 * class attributes rather than interpreting structure. `sanitize-html`
 * normalises attributes to double quotes, so the shape is predictable.
 */
function classesIn(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\sclass="([^"]*)"/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls) out.push(cls);
  }
  return out;
}

/**
 * @param installedClasses  Root classes contributed by plugins that are
 *   installed and active. Without these, every page using a perfectly healthy
 *   plugin section is reported as broken — the audit knows the core vocabulary
 *   from code but can only learn the plugin vocabulary from the caller.
 */
export function auditSections(
  posts: readonly Post[],
  installedClasses: Iterable<string> = [],
): SectionAudit {
  const allowed = new Set(sectionClassList());
  const installed = new Set(installedClasses);
  const orphanCounts = new Map<string, number>();
  const unknownCounts = new Map<string, number>();
  const usageCounts = new Map<string, number>();
  const affected: AuditRow[] = [];
  let usingSections = 0;

  for (const post of posts) {
    const html = post.content ?? '';
    if (!html.includes(SECTION_PREFIX)) continue;

    const present = new Set(classesIn(html).filter((c) => c.startsWith(SECTION_PREFIX)));
    if (present.size === 0) continue;
    usingSections++;

    for (const s of SECTIONS) {
      if (present.has(`${SECTION_PREFIX}${s.name}`)) {
        usageCounts.set(s.name, (usageCounts.get(s.name) ?? 0) + 1);
      }
    }

    const unknown: string[] = [];
    const orphaned: string[] = [];
    for (const cls of present) {
      if (allowed.has(cls) || installed.has(cls)) continue;
      // A well-formed plugin class with no plugin behind it is orphaned, not
      // unknown: the sanitizer keeps it, so nothing is at risk.
      if (isPluginSectionClass(cls)) orphaned.push(cls);
      else unknown.push(cls);
    }
    unknown.sort();
    orphaned.sort();
    if (unknown.length === 0 && orphaned.length === 0) continue;

    for (const c of unknown) unknownCounts.set(c, (unknownCounts.get(c) ?? 0) + 1);
    for (const c of orphaned) orphanCounts.set(c, (orphanCounts.get(c) ?? 0) + 1);
    affected.push({
      id: post.id,
      title: post.title,
      slug: post.slug,
      kind: post.kind === 'page' ? 'page' : 'post',
      status: post.status,
      unknownClasses: unknown,
      orphanedPluginClasses: orphaned,
    });
  }

  return {
    affected,
    unknownTotals: [...unknownCounts.entries()]
      .map(([className, records]) => ({ className, records }))
      .sort((a, b) => b.records - a.records || a.className.localeCompare(b.className)),
    orphanedTotals: [...orphanCounts.entries()]
      .map(([className, records]) => ({ className, records }))
      .sort((a, b) => b.records - a.records || a.className.localeCompare(b.className)),
    usingSections,
    scanned: posts.length,
    usage: SECTIONS
      .map((s) => ({ name: s.name, records: usageCounts.get(s.name) ?? 0 }))
      .sort((a, b) => b.records - a.records || a.name.localeCompare(b.name)),
  };
}

/** Split for display — pages and articles fail differently and are fixed differently. */
export function auditByKind(posts: readonly Post[], installedClasses: Iterable<string> = []) {
  return {
    pages: auditSections(pagesOnly(posts), installedClasses),
    articles: auditSections(articlesOnly(posts), installedClasses),
  };
}
