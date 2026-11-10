import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { consentRowsFor } from '../../../lib/consent-service';
import { consentState, ConsentInputError } from '../../../lib/consent-ledger';
import type { ConsentLedgerRow } from '../../../core/models';

/**
 * The consent ledger for ONE address — read-only.
 *
 * `GET ?email=…` → every row ever written for it, in the order written (who
 * recorded it, what for, yes or no, when, which wording), plus the current
 * state per purpose. Nothing here can change a row: the ledger is append-only
 * and the only way to change a state is to append — see `ledger/withdraw`.
 *
 * Admin only, like the data-request screen it belongs to: it returns one
 * person's decisions, and possibly the address and browser they made them
 * from, from an email address alone.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    if (locals.user.role !== 'admin') {
      return ApiResponseBuilder.forbidden('Only an administrator can read the consent ledger');
    }
    let rows: ConsentLedgerRow[];
    try {
      rows = await consentRowsFor(new URL(url).searchParams.get('email') ?? '');
    } catch (err) {
      if (err instanceof ConsentInputError) return ApiResponseBuilder.badRequest('That is not an email address');
      throw err;
    }
    const purposes = [...new Set(rows.map((r) => r.purpose))].sort();
    const state = purposes.map((purpose) => {
      const s = consentState(rows.filter((r) => r.purpose === purpose));
      return { purpose, granted: s.granted, confirmed: s.confirmed, withdrawn: s.withdrawn, latest_at: s.latest?.at ?? null };
    });
    return ApiResponseBuilder.success({ email: rows[0]?.email ?? null, rows, state }, 'Consent ledger');
  } catch (err) {
    console.error('Consent ledger read error:', err);
    return ApiResponseBuilder.serverError('Could not read the consent ledger');
  }
};
