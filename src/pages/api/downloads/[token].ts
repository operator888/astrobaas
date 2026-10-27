/**
 * GET /api/downloads/{token} — one purchased file, for whoever holds a valid
 * signed link (lib/commerce/download-entitlements.ts).
 *
 * Public, because the token IS the credential: it is an HMAC over the order,
 * the entitlement and the file, it expires (24 h by default), and it is only
 * ever shown on the buyer's receipt. Every check runs on the order as it is
 * NOW — paid, not refunded or cancelled, not revoked by staff, not expired,
 * under its limit — and the download is COUNTED by compare-and-set before a
 * byte is sent, so two at once cannot both take the last one.
 *
 * How the file is delivered depends on where it lives:
 *
 *  - `private:pf_…` — streamed from the private uploads directory as an
 *    attachment. Its location is never disclosed.
 *  - `https://…` / `/…` — a 302 to it, issued only after the checks pass. The
 *    buyer's browser then sees that URL: hosting a file elsewhere means its
 *    address is visible to the people who bought it. Use a private upload when
 *    that matters.
 *
 * Refusals are JSON with a stable `error.reason` (`downloads.<code>`), so a
 * storefront can explain "expired" differently from "limit reached".
 */
import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { sharedRateLimitStore } from '../../../lib/rate-limit';
import { claimDownload, readDownloadToken, refusal } from '../../../lib/commerce/download-entitlements';
import { privateDownloadId } from '../../../lib/product-fields';
import { readPrivateFileMeta, openPrivateFileStream } from '../../../lib/media/private-files';

export const prerender = false;

/** Downloads one address may START per minute. Generous for a person, not for a script. */
const PER_MINUTE = 30;

const NO_STORE = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

function refuse(code: Parameters<typeof refusal>[0]): Response {
  const r = refusal(code);
  const res = ApiResponseBuilder.error(r.status, r.message, undefined, { code: `downloads.${code}` });
  for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
  return res;
}

/** A filename safe inside a quoted Content-Disposition, plus the RFC 5987 form for non-ASCII. */
function disposition(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim().slice(0, 150) || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    const token = String((params as { token?: string }).token ?? '');
    // A forged or expired link costs nothing to refuse and is not counted
    // against anyone's budget.
    if (!readDownloadToken(token)) return refuse('link_invalid');

    const allowed = await sharedRateLimitStore().hit(`download:${locals.ip ?? 'unknown'}`, 60_000, PER_MINUTE);
    if (!allowed) return ApiResponseBuilder.error(429, 'Too many downloads; try again in a minute.');

    const claim = await claimDownload(token, locals.ip ?? null);
    if (!claim.ok) return refuse(claim.code);

    const { file } = claim;
    const pfId = privateDownloadId(file.url);
    if (pfId) {
      const meta = await readPrivateFileMeta(pfId);
      const opened = meta ? await openPrivateFileStream(meta) : null;
      if (!meta || !opened) {
        console.error(`[downloads] private file ${pfId} for entitlement ${claim.entitlement.id} is missing`);
        return refuse('file_missing');
      }
      const ext = meta.rel.split('.').pop() ?? '';
      const name = /\.[a-z0-9]{2,5}$/i.test(file.name) || !ext ? file.name : `${file.name}.${ext}`;
      return new Response(opened.stream, {
        status: 200,
        headers: {
          ...NO_STORE,
          'Content-Type': meta.mime_type,
          'Content-Length': String(opened.size),
          'Content-Disposition': disposition(name),
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    // https or own media: the buyer is sent there. See the header for what
    // that discloses.
    return new Response(null, { status: 302, headers: { ...NO_STORE, Location: file.url } });
  } catch (err) {
    console.error('Download error:', err);
    return ApiResponseBuilder.serverError('Could not serve the download');
  }
};

/**
 * HEAD checks the LINK only and never counts: link checkers and download
 * managers send one first, and a HEAD that spent a download would empty a
 * small limit before the buyer clicked.
 */
export const HEAD: APIRoute = async ({ params }) => {
  const ok = !!readDownloadToken(String((params as { token?: string }).token ?? ''));
  return new Response(null, { status: ok ? 204 : 403, headers: NO_STORE });
};
