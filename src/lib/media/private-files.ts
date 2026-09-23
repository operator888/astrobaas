/**
 * Files a STRANGER uploaded through a public form (C-23).
 *
 * ## Why these are not media-library files
 *
 * `ingestMedia` writes into `public/uploads`, which Astro's static handler
 * serves in dev and a reverse proxy serves in most production deployments — the
 * `/uploads/[...path]` route only gets a look in a standalone Node build. A
 * file written there is readable at its URL whatever the record's read policy
 * says. A content type marked `visibility: 'staff'` collecting CVs,
 * prescriptions or ID scans would have been publishing them while its own
 * settings screen said "staff only".
 *
 * So a submission file goes somewhere no static handler is told about, and is
 * reachable only through an authenticated route. It also stays OUT of the media
 * library: a stranger's CV appearing in the picker an editor uses to choose a
 * hero image is a mistake waiting to be made once.
 *
 * ## Shape on disk
 *
 * `<private>/yyyy/mm/<id>.<ext>` for the bytes, `<id>.json` beside it for the
 * original name and type. A sidecar rather than a database table because the
 * only reader is the download route and the only writer is the upload route —
 * a fourth top-level table would need a migration on three drivers, a backup
 * entry, and a line in the GDPR sweep, for a lookup by primary key.
 *
 * Content-addressed, so the same file uploaded twice is stored once — and the
 * id is derived from the bytes, so it is unguessable without them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getPrivateUploadsDir } from '../paths';
import { refuseIfInfected } from './scan';
import { settingInt } from '../settings-map';

/** Ids carry a prefix so a private file can never be mistaken for a library id. */
export const PRIVATE_FILE_PREFIX = 'pf_';
const ID_RE = /^pf_[0-9a-f]{20}$/;

/** Smaller than the library's 10 MB: this is an anonymous door. */
export const MAX_SUBMISSION_FILE_SIZE = 5 * 1024 * 1024;

/**
 * What a public form may upload.
 *
 * Narrower than the media library's list, and narrowed by MAGIC BYTES rather
 * than by the filename or the client's Content-Type, both of which the
 * uploader controls. No SVG: an SVG is a document that can carry script, and
 * the library only accepts one because it sanitises it on the way in for an
 * editor who chose it deliberately.
 */
const KINDS = {
  png: { ext: 'png', mime: 'image/png' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  gif: { ext: 'gif', mime: 'image/gif' },
  webp: { ext: 'webp', mime: 'image/webp' },
  pdf: { ext: 'pdf', mime: 'application/pdf' },
} as const;

type Kind = keyof typeof KINDS;

/** Decide what a file IS from its bytes. Mirrors `sniff` in ingest.ts. */
function sniff(buf: Buffer): Kind | null {
  if (
    buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 6
    && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) return 'gif';
  if (
    buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
  ) return 'webp';
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  return null;
}

export interface PrivateFile {
  id: string;
  /** As the uploader named it, cleaned. Shown to staff, never used as a path. */
  original_name: string;
  mime_type: string;
  size: number;
  created_at: string;
  /** Where the bytes are, relative to the private root. Never sent to a client. */
  rel: string;
  /**
   * The form (content type) it was uploaded through.
   *
   * Absent on files written before quotas existed. It is what the per-form
   * quota adds up and what the orphan sweep looks in first; a file without one
   * is never swept, because nothing says where its owner would be.
   */
  form?: string;
}

export function isPrivateFileId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/**
 * A filename safe to show and to put in a Content-Disposition header.
 *
 * Never used to build a path — the path comes from the content hash — so this
 * is about what a person reads, and about not letting a header be split.
 */
function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  const base = s.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim().slice(0, 120) || 'file';
}

export type StoreResult =
  | { ok: true; file: PrivateFile }
  /**
   * `reason` is set only for the refusal a client should handle differently
   * from "fix your file": the form's storage is full, and sending a smaller or
   * different file will not help.
   */
  | { ok: false; error: string; reason?: 'quota' };

export interface StoreOptions {
  /** The form (content type) this upload belongs to. Recorded in the sidecar. */
  form?: string;
  /**
   * The most bytes this form's uploads may occupy in total, this one included.
   * Omit for no quota. Only enforced together with `form`.
   */
  quotaBytes?: number;
}

/**
 * Per-form ceiling on stored uploads, when the operator has not set one.
 *
 * ## Why a quota
 *
 * The per-IP limit is five uploads per quarter hour. That bounds one client,
 * not a thousand: a botnet uploading 5 MB files through a public form fills a
 * VPS disk in hours, and a full disk takes the DATABASE down with it — every
 * order, not just the form. A ceiling per form turns "the server is down" into
 * "this one form is refusing files", which an operator can see and fix.
 *
 * 1 GiB is two hundred maximum-size files, far more than a contact or job form
 * collects between clean-ups, and small next to the disks both live shops run
 * on. `form_upload_quota_mb` changes it; `0` means no quota.
 */
export const FORM_UPLOAD_QUOTA_KEY = 'form_upload_quota_mb';
export const DEFAULT_FORM_UPLOAD_QUOTA_MB = 1024;

/** The quota in bytes from a settings map, or `undefined` for none. */
export function resolveFormUploadQuota(settings: Record<string, unknown> | null | undefined): number | undefined {
  // A negative value is nonsense rather than a decision, so it reads as the
  // default — clamping it to 0 would silently switch the quota OFF.
  const raw = settings?.[FORM_UPLOAD_QUOTA_KEY];
  const asNumber = Number(raw);
  const mb = Number.isFinite(asNumber) && asNumber < 0
    ? DEFAULT_FORM_UPLOAD_QUOTA_MB
    : settingInt(raw, DEFAULT_FORM_UPLOAD_QUOTA_MB, { min: 0, max: 1024 * 1024 });
  return mb === 0 ? undefined : mb * 1024 * 1024;
}

/**
 * The stable reason code a full form answers with (`error.reason`). A
 * storefront keys its message on this, not on the English sentence — and not
 * on the status alone, because 413 also means "this one file is too big",
 * which the visitor CAN fix.
 */
export const QUOTA_EXCEEDED_REASON = 'forms.upload_quota_exceeded';

/** The refusal a full form answers with — one stable string. */
export const QUOTA_EXCEEDED_MESSAGE =
  'This form is not accepting more files right now. Please try again later or contact us directly.';

/** Write a stranger's bytes somewhere only an authenticated route can read. */
export async function storePrivateFile(
  buf: Buffer,
  originalName: unknown,
  opts: StoreOptions = {},
): Promise<StoreResult> {
  if (!buf || buf.length === 0) return { ok: false, error: 'The file is empty.' };
  if (buf.length > MAX_SUBMISSION_FILE_SIZE) {
    return { ok: false, error: `Files must be under ${Math.floor(MAX_SUBMISSION_FILE_SIZE / (1024 * 1024))} MB.` };
  }
  // The virus scan (C-76). This door matters MORE than the media library's,
  // not less: these bytes come from a stranger rather than from a colleague,
  // and the file is downloaded later by whoever handles the submission. A scan
  // wired into the admin upload and not into this one would protect the person
  // least at risk.
  const infected = await refuseIfInfected(buf);
  if (infected) return { ok: false, error: infected };

  const kind = sniff(buf);
  if (!kind) {
    return { ok: false, error: 'That file type is not accepted. Send a PNG, JPEG, GIF, WebP or PDF.' };
  }

  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20);
  const id = `${PRIVATE_FILE_PREFIX}${hash}`;
  const now = new Date();
  const dir = path.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
  const rel = path.join(dir, `${id}.${KINDS[kind].ext}`);

  const abs = path.join(getPrivateUploadsDir(), rel);
  const form = typeof opts.form === 'string' && opts.form ? opts.form : undefined;

  // The quota check and the write are ONE step per form. Two uploads racing
  // past a check-then-write would each see room for themselves and together
  // overfill it; serialising per form keeps the ceiling exact in this process.
  return withFormLock(form, async (): Promise<StoreResult> => {
    // Content-addressed: the same bytes already stored in this month's folder
    // occupy no new space, so they cannot be what breaks the quota.
    const alreadyThere = await fs.stat(abs).then((s) => s.isFile(), () => false);
    if (form && opts.quotaBytes !== undefined && !alreadyThere) {
      const used = (await usageByForm()).get(form) ?? 0;
      if (used + buf.length > opts.quotaBytes) {
        return { ok: false, error: QUOTA_EXCEEDED_MESSAGE, reason: 'quota' };
      }
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);

    const file: PrivateFile = {
      id,
      original_name: cleanName(originalName),
      mime_type: KINDS[kind].mime,
      size: buf.length,
      // Re-stamped on a repeat upload of the same bytes, on purpose: the
      // orphan sweep measures age from here, and a file somebody has just
      // uploaded again is about to be attached, not abandoned.
      created_at: now.toISOString(),
      rel: rel.split(path.sep).join('/'),
      ...(form ? { form } : {}),
    };
    await fs.writeFile(path.join(getPrivateUploadsDir(), dir, `${id}.json`), JSON.stringify(file));
    if (form && !alreadyThere) noteUsage(form, buf.length);
    return { ok: true, file };
  });
}

/* ---------- Per-form usage ---------- */

/**
 * Bytes stored per form, from the sidecars, remembered briefly.
 *
 * Adding it up means reading every sidecar, which is fine once a minute and
 * wasteful on every upload of a busy form. So the total is kept for
 * {@link USAGE_TTL_MS} and adjusted in place by this process's own writes;
 * anything else that changes the directory (a delete, the sweep, another
 * replica) drops it and the next check re-reads the disk. A quota a minute
 * behind another replica's uploads is soft by at most what that replica's
 * rate limit allowed in a minute.
 */
const USAGE_TTL_MS = 60 * 1000;
let usageMemo: { at: number; byForm: Map<string, number> } | null = null;

async function usageByForm(): Promise<Map<string, number>> {
  const now = Date.now();
  if (usageMemo && now - usageMemo.at < USAGE_TTL_MS) return usageMemo.byForm;
  const byForm = new Map<string, number>();
  for (const f of await listPrivateFiles()) {
    if (!f.form) continue;
    byForm.set(f.form, (byForm.get(f.form) ?? 0) + (Number.isFinite(f.size) ? f.size : 0));
  }
  usageMemo = { at: now, byForm };
  return byForm;
}

function noteUsage(form: string, delta: number): void {
  if (!usageMemo) return;
  usageMemo.byForm.set(form, Math.max(0, (usageMemo.byForm.get(form) ?? 0) + delta));
}

/** Forget the remembered totals. Called by every path that removes files. */
export function invalidateFormUsage(): void {
  usageMemo = null;
}

/** Bytes currently stored for `form`. For the admin and for tests. */
export async function formUsageBytes(form: string): Promise<number> {
  return (await usageByForm()).get(form) ?? 0;
}

const formLocks = new Map<string, Promise<unknown>>();

async function withFormLock<T>(form: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!form) return fn();
  const previous = formLocks.get(form) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // The chain holds a settled promise, never a rejection, so one failed upload
  // cannot poison every later one for the same form.
  const settled = run.then(() => undefined, () => undefined);
  formLocks.set(form, settled);
  try {
    return await run;
  } finally {
    if (formLocks.get(form) === settled) formLocks.delete(form);
  }
}

/**
 * Every sidecar under the private root, parsed. Unreadable ones are skipped.
 *
 * `dir` is the month folder the sidecar was found in, which is not always the
 * folder `rel` names: a sidecar is trusted for its metadata, never for where
 * to delete.
 */
export async function listPrivateFiles(): Promise<(PrivateFile & { dir: string })[]> {
  const root = getPrivateUploadsDir();
  const out: (PrivateFile & { dir: string })[] = [];
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return out;
  }
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    let months: string[];
    try {
      months = await fs.readdir(path.join(root, y));
    } catch {
      continue;
    }
    for (const m of months) {
      if (!/^\d{2}$/.test(m)) continue;
      const dir = path.join(root, y, m);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -'.json'.length);
        if (!isPrivateFileId(id)) continue;
        try {
          const parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as PrivateFile;
          if (parsed?.id === id) out.push({ ...parsed, dir });
        } catch {
          /* a torn or hand-edited sidecar is skipped, never guessed at */
        }
      }
    }
  }
  return out;
}

/** Look one up. Returns null for an unknown or malformed id — never throws. */
export async function readPrivateFileMeta(id: unknown): Promise<PrivateFile | null> {
  if (!isPrivateFileId(id)) return null;
  const root = getPrivateUploadsDir();
  // The id says nothing about which month it landed in, so the sidecar is
  // found by walking the two levels the writer creates. A flat directory would
  // have avoided this and put every file a shop ever received in one folder.
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const y of years) {
    let months: string[];
    try {
      months = await fs.readdir(path.join(root, y));
    } catch {
      continue;
    }
    for (const m of months) {
      const meta = path.join(root, y, m, `${id}.json`);
      try {
        const raw = await fs.readFile(meta, 'utf8');
        const parsed = JSON.parse(raw) as PrivateFile;
        return parsed?.id === id ? parsed : null;
      } catch {
        /* not in this month */
      }
    }
  }
  return null;
}

/** The bytes, or null. */
export async function readPrivateFile(file: PrivateFile): Promise<Buffer | null> {
  const root = getPrivateUploadsDir();
  const abs = path.resolve(root, file.rel);
  // Belt and braces: `rel` came from a sidecar we wrote, but a restored or
  // hand-edited one must not be able to read outside the private root.
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/**
 * Delete a stranger's file and its sidecar.
 *
 * Called by the GDPR erasure path: a submission erased from the database while
 * its attachment stays on disk is an erasure that did not erase.
 */
export async function deletePrivateFile(id: unknown): Promise<boolean> {
  const meta = await readPrivateFileMeta(id);
  if (!meta) return false;
  const root = getPrivateUploadsDir();
  const abs = path.resolve(root, meta.rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  await fs.rm(abs, { force: true });
  await fs.rm(path.join(path.dirname(abs), `${meta.id}.json`), { force: true });
  invalidateFormUsage();
  return true;
}

/* ---------- Orphans ---------- */

/**
 * How long an upload may wait for the submission that names it.
 *
 * ## What an orphan is, and why they pile up
 *
 * A public form uploads its file FIRST, gets an id back, and only then submits
 * the record that names the id. Every visitor who picks a file and then closes
 * the tab leaves bytes behind, and so does every bot that found the upload
 * endpoint and never bothered with the form. Nothing ever removed them: the
 * only delete was the GDPR erasure, which starts from a submission — and an
 * orphan, by definition, has none.
 *
 * A day is generous for a person to finish a form, and short enough that a
 * stranger's abandoned CV does not sit on the server for months with no record
 * anyone can find it through. `form_upload_orphan_hours` changes it.
 */
export const ORPHAN_HOURS_KEY = 'form_upload_orphan_hours';
export const DEFAULT_ORPHAN_HOURS = 24;

/** The grace period in ms. At least an hour: a form takes time to fill in. */
export function resolveOrphanMaxAgeMs(settings: Record<string, unknown> | null | undefined): number {
  const hours = settingInt(settings?.[ORPHAN_HOURS_KEY], DEFAULT_ORPHAN_HOURS, { min: 1, max: 24 * 365 });
  return hours * 60 * 60 * 1000;
}

export interface OrphanSweepInput {
  now?: number;
  maxAgeMs: number;
  /**
   * Every private-file id that some stored record names, looked up in (at
   * least) the given forms. May THROW: a sweep that cannot prove a file is
   * unattached deletes nothing.
   */
  referencedIds: (forms: ReadonlySet<string>) => Promise<ReadonlySet<string>>;
}

export interface OrphanSweepResult {
  /** Files deleted this pass. */
  removed: number;
  /** Old enough, but attached to a record. */
  attached: number;
  /** Set when the reference lookup failed and nothing was touched. */
  error?: string;
}

/**
 * Delete uploads older than the grace period that no record names.
 *
 * Deliberately conservative, because what it deletes is a customer's file:
 *
 *   - only files whose sidecar names the FORM they came through. A file from
 *     before that was recorded has nowhere to be looked up, so it is kept;
 *   - only when the reference lookup succeeded — a storage error mid-sweep is
 *     "delete nothing", never "nothing is referenced";
 *   - age from the sidecar's own `created_at`; an unreadable one is kept;
 *   - the delete is confined to the private root, whatever a sidecar claims.
 */
export async function sweepOrphanPrivateFiles(input: OrphanSweepInput): Promise<OrphanSweepResult> {
  const now = input.now ?? Date.now();
  const root = getPrivateUploadsDir();
  const candidates = (await listPrivateFiles()).filter((f) => {
    if (!f.form) return false;
    const born = Date.parse(f.created_at);
    return Number.isFinite(born) && now - born >= input.maxAgeMs;
  });
  if (candidates.length === 0) return { removed: 0, attached: 0 };

  let referenced: ReadonlySet<string>;
  try {
    referenced = await input.referencedIds(new Set(candidates.map((f) => f.form!)));
  } catch (err) {
    return { removed: 0, attached: 0, error: err instanceof Error ? err.message : String(err) };
  }

  let removed = 0;
  let attached = 0;
  for (const f of candidates) {
    if (referenced.has(f.id)) {
      attached += 1;
      continue;
    }
    const abs = path.resolve(root, f.rel);
    if (abs === root || !abs.startsWith(root + path.sep)) continue;
    await fs.rm(abs, { force: true });
    await fs.rm(path.join(f.dir, `${f.id}.json`), { force: true });
    removed += 1;
  }
  if (removed) invalidateFormUsage();
  return { removed, attached };
}

/** Every private-file id mentioned anywhere in a record's data. */
export function privateFileIdsIn(value: unknown): string[] {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return [];
  }
  // Matched in the serialised record rather than through the type's field
  // definitions, on purpose: a definition can change or be unregistered (a
  // plugin switched off) while its records — and the files they name — stay.
  // Reading the definition would make those files look unattached.
  return text.match(/pf_[0-9a-f]{20}/g) ?? [];
}
