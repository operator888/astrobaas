/**
 * A checksum manifest of what is deployed, and a way to check it later (C-82).
 *
 * ## What this can and cannot tell you
 *
 * It answers one question: *are the files on this server the files that were
 * built?* That catches a modified `dist/`, a dropped file, a plugin edited in
 * place on a live box — the whole category of "somebody changed something and
 * nobody knows what".
 *
 * It is NOT tamper-proof, and pretending otherwise would be the dangerous
 * version of this feature. The manifest sits on the same disk as the files it
 * describes, so anyone who can rewrite the files can rewrite the manifest.
 * What makes it useful is the DIGEST of the manifest itself, printed on
 * generation: written down somewhere that is not this server — a deploy log, a
 * password manager, a colleague's notes — it turns a local file into a real
 * check. The verify command prints it too, which is the whole workflow.
 *
 * ## Sorted, relative, forward-slashed
 *
 * All three so that the manifest of a build is byte-identical on Linux and on
 * the macOS laptop it was built on. A manifest that differs by platform cannot
 * be compared against anything.
 */
import crypto from 'node:crypto';

export const INTEGRITY_VERSION = 1;

export interface IntegrityManifest {
  version: number;
  /** When it was generated. Informational — it is not part of the digest input. */
  generated_at: string;
  /** Relative POSIX path → sha256, sorted by path. */
  files: Record<string, string>;
}

export function hashBuffer(buf: Uint8Array | Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Build a manifest from paths already hashed. Pure, so the walk stays in the script. */
export function buildManifest(entries: Iterable<[string, string]>, generatedAt: string): IntegrityManifest {
  // A NULL-PROTOTYPE bag. With a plain `{}`, `'toString' in files` is true for a
  // file that was never recorded, so dropping `dist/toString` — or
  // `constructor`, `valueOf`, `hasOwnProperty` — into a deployment passed
  // verification with "integrity: unchanged". Those are the ADDED category,
  // which this module says is the one people forget to look for and the one a
  // web shell is. Worse, `files['__proto__'] = hash` is a silent no-op, so such
  // a file was never even hashed.
  const files: Record<string, string> = Object.create(null);
  for (const [p, h] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    files[p] = h;
  }
  return { version: INTEGRITY_VERSION, generated_at: generatedAt, files };
}

/**
 * The manifest's own fingerprint.
 *
 * Over the FILE LIST only — not `generated_at`, so regenerating an unchanged
 * build produces the same digest and an operator comparing two deploys sees
 * "identical" rather than "different, because time passed".
 */
export function manifestDigest(manifest: IntegrityManifest): string {
  const lines = Object.entries(manifest.files)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([p, h]) => `${h}  ${p}`);
  return hashBuffer(lines.join('\n'));
}

export interface IntegrityDiff {
  changed: string[];
  added: string[];
  removed: string[];
  ok: boolean;
}

/**
 * Compare a manifest to what is on disk now.
 *
 * Three categories rather than one, because they mean different things:
 * `changed` is a file whose contents differ, `added` is a file nobody built,
 * and `removed` is one that is gone. An "added" file is the one people forget
 * to look for and the one a web shell is.
 */
export function diffManifest(
  manifest: IntegrityManifest,
  actual: Record<string, string>,
): IntegrityDiff {
  const changed: string[] = [];
  const removed: string[] = [];
  // `Object.hasOwn`, never `in`: the prototype chain makes `'toString' in obj`
  // true for an object that never had one, which hid exactly the files an
  // attacker would choose. See the note in `buildManifest`.
  const expected = manifest.files ?? {};
  for (const [p, h] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, p)) removed.push(p);
    else if (actual[p] !== h) changed.push(p);
  }
  const added = Object.keys(actual).filter((p) => !Object.hasOwn(expected, p));
  changed.sort(); added.sort(); removed.sort();
  return { changed, added, removed, ok: !changed.length && !added.length && !removed.length };
}

/** A readable, machine-greppable summary. */
export function describeDiff(diff: IntegrityDiff): string {
  if (diff.ok) return 'integrity: unchanged';
  const parts: string[] = [];
  for (const [label, list] of [['changed', diff.changed], ['added', diff.added], ['removed', diff.removed]] as const) {
    if (list.length) parts.push(`${list.length} ${label}`);
  }
  return `integrity: ${parts.join(', ')}`;
}
