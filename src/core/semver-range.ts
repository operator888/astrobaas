/**
 * A deliberately small semver range matcher.
 *
 * Plugin dependencies need "does version X satisfy range R". The npm `semver`
 * package answers that completely — and would be the right call if this lived
 * anywhere else. It cannot: `src/core/` is published as `astrobaas/core` and is
 * dependency-free on purpose, and this same code runs in the CLI, the admin and
 * the validator.
 *
 * So this implements a SUBSET and, critically, **refuses what it does not
 * understand** rather than guessing. An unparseable range is an error at
 * validation time, which a plugin author sees immediately, instead of a silent
 * `false` that would make their dependency look permanently unsatisfiable.
 *
 * Supported:
 *   `1.2.3`     exact
 *   `=1.2.3`    exact
 *   `^1.2.3`    compatible-with — same leftmost non-zero, at or above
 *   `~1.2.3`    approximately   — same major.minor, at or above patch
 *   `>=1.2.3`   at or above          `>1.2.3`  above
 *   `<=1.2.3`   at or below          `<1.2.3`  below
 *   `*`         any version
 *
 * Deliberately NOT supported: `||` unions, hyphen ranges, `x`/`X` wildcards in
 * positions, and pre-release precedence rules. Each is a place to be subtly
 * wrong, and none is needed to say "this pack needs commerce 2.x".
 *
 * Pre-release versions (`2.0.0-beta.1`) parse, and compare BELOW their release,
 * but a range never matches one unless it names a pre-release itself — the npm
 * rule, and the one that stops `^2.0.0` quietly accepting an unfinished build.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers after `-`, or [] for a release version. */
  prerelease: (string | number)[];
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a semver string. Returns null rather than throwing on junk. */
export function parseVersion(input: string): ParsedVersion | null {
  const m = VERSION_RE.exec(String(input ?? '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    // Numeric identifiers compare numerically, alphanumeric ones lexically.
    prerelease: m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
  };
}

/** -1 | 0 | 1, following semver precedence including pre-release ordering. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // A version WITH a pre-release is lower than the same version without one.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    // A longer pre-release outranks a shorter prefix of itself.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = typeof x === 'number';
    const yNum = typeof y === 'number';
    // Numeric identifiers always compare lower than alphanumeric ones.
    if (xNum && !yNum) return -1;
    if (!xNum && yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const OPERATOR_RE = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/;

/** Whether a range string is one this matcher understands. */
export function isValidRange(range: string): boolean {
  const raw = String(range ?? '').trim();
  if (raw === '*' || raw.toLowerCase() === 'any') return true;
  const m = OPERATOR_RE.exec(raw);
  if (!m) return false;
  return parseVersion(m[2]) !== null;
}

/**
 * Does `version` satisfy `range`?
 *
 * Returns false for anything unparseable. Callers that care about the
 * difference between "does not satisfy" and "is not a range I understand"
 * should call `isValidRange` first — the manifest validator does, so an author
 * gets told their range is malformed rather than watching it never match.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;

  const raw = String(range ?? '').trim();
  if (raw === '*' || raw.toLowerCase() === 'any') return v.prerelease.length === 0;

  const m = OPERATOR_RE.exec(raw);
  if (!m) return false;
  const op = m[1] ?? '=';
  const target = parseVersion(m[2]);
  if (!target) return false;

  // A pre-release only ever satisfies a range that names one at the same
  // [major, minor, patch]. Without this, `^2.0.0` would accept `2.1.0-alpha.1`
  // and a dependent would activate against an unfinished build.
  if (v.prerelease.length > 0) {
    const sameTuple = v.major === target.major && v.minor === target.minor && v.patch === target.patch;
    if (!sameTuple || target.prerelease.length === 0) return false;
  }

  const cmp = compareVersions(v, target);

  switch (op) {
    case '=': return cmp === 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '~':
      // Same major.minor, at or above the target patch.
      return cmp >= 0 && v.major === target.major && v.minor === target.minor;
    case '^': {
      if (cmp < 0) return false;
      // "Compatible" is keyed on the leftmost NON-ZERO component, because
      // 0.x releases treat minor as breaking and 0.0.x treats patch as breaking.
      if (target.major !== 0) return v.major === target.major;
      if (target.minor !== 0) return v.major === 0 && v.minor === target.minor;
      return v.major === 0 && v.minor === 0 && v.patch === target.patch;
    }
    default: return false;
  }
}
