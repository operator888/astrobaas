/**
 * The GoBD archive: every document as it was SENT, and every receipt as it
 * was RECEIVED, kept unchanged.
 *
 * Stored on local disk under `<private uploads>/finance/<year>/`, outside the
 * web root and never served directly — only through the module's staff-gated
 * route or a customer's unguessable public-token link.
 *
 * Content-addressed (the id is a hash of the bytes) and write-once: a file is
 * never overwritten, so "the PDF we archived" and "the PDF the customer got"
 * cannot drift apart. GoBD wants exactly that — unalterable storage, or a
 * record of every alteration; this is the first kind.
 *
 * Retention is 8 years for invoices and receipts (§147 AO as amended by
 * BEG IV, 2025). Nothing here deletes; the operator's backup must include
 * this directory — see the module's README.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getPrivateUploadsDir } from '../../../lib/paths';
import { refuseIfInfected } from '../../../lib/media/scan';

import { FINANCE_UPLOAD_MAX_BYTES } from './limits';

export const ARCHIVE_MAX_BYTES = FINANCE_UPLOAD_MAX_BYTES;

export type ArchiveKind = 'pdf' | 'xml' | 'png' | 'jpeg' | 'webp' | 'csv' | 'zip';

const MIME: Record<ArchiveKind, string> = {
  pdf: 'application/pdf', xml: 'application/xml', png: 'image/png', jpeg: 'image/jpeg',
  webp: 'image/webp', csv: 'text/csv', zip: 'application/zip',
};

export interface ArchivedFile {
  id: string;
  kind: ArchiveKind;
  mime: string;
  name: string;
  size: number;
  sha256: string;
  created_at: string;
  rel: string;
}

const ID_RE = /^fa_[0-9a-f]{32}$/;

export function sniffKind(buf: Uint8Array): ArchiveKind | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  if (b.length >= 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  const head = b.toString('utf8', 0, Math.min(b.length, 512)).replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<?xml') || /^<([A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*[\s>]/.test(head)) return 'xml';
  return null;
}

function root(): string {
  return path.join(getPrivateUploadsDir(), 'finance');
}

function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return (raw.split(/[/\\]/).pop() ?? '').replace(/[\u0000-\u001f\u007f"\\]/g, '').trim().slice(0, 120) || 'file';
}

export async function archiveFile(bytes: Uint8Array, name: string, forceKind?: ArchiveKind): Promise<ArchivedFile> {
  if (!bytes.length) throw new Error('The file is empty.');
  if (bytes.length > ARCHIVE_MAX_BYTES) throw new Error('Files must be under 15 MB.');
  const kind = forceKind ?? sniffKind(bytes);
  if (!kind) throw new Error('Unsupported file type. Send a PDF, XML (e-invoice), PNG, JPEG or WebP.');
  const buf = Buffer.from(bytes);
  const infected = await refuseIfInfected(buf);
  if (infected) throw new Error(infected);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const id = `fa_${sha256.slice(0, 32)}`;
  const year = String(new Date().getUTCFullYear());
  const rel = `${year}/${id}.${kind === 'jpeg' ? 'jpg' : kind}`;
  const abs = path.join(root(), rel);
  const meta: ArchivedFile = {
    id, kind, mime: MIME[kind], name: cleanName(name), size: buf.length, sha256,
    created_at: new Date().toISOString(), rel,
  };
  const existing = await readMeta(id);
  if (existing) return existing; // same bytes already archived — write-once
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // 'wx' — never overwrite an archived file.
  await fs.writeFile(abs, buf, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e;
  });
  await fs.writeFile(path.join(root(), 'index', `${id}.json`), JSON.stringify(meta), { flag: 'w' })
    .catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      await fs.mkdir(path.join(root(), 'index'), { recursive: true });
      await fs.writeFile(path.join(root(), 'index', `${id}.json`), JSON.stringify(meta));
    });
  return meta;
}

export async function readMeta(id: unknown): Promise<ArchivedFile | null> {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(root(), 'index', `${id}.json`), 'utf8')) as ArchivedFile;
  } catch {
    return null;
  }
}

export async function readArchived(id: unknown): Promise<{ meta: ArchivedFile; bytes: Buffer } | null> {
  const meta = await readMeta(id);
  if (!meta) return null;
  const abs = path.resolve(root(), meta.rel);
  if (!abs.startsWith(path.resolve(root()) + path.sep)) return null;
  try {
    const bytes = await fs.readFile(abs);
    // Integrity: the bytes must still hash to what was archived.
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha !== meta.sha256) {
      console.error(`[ecws-billing] archived file ${id} fails its checksum — it was altered on disk.`);
      return null;
    }
    return { meta, bytes };
  } catch {
    return null;
  }
}
