import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { canReadCommerce } from '../../../../lib/auth';
import { recordAudit, AUDIT } from '../../../../lib/audit';
import { settingsMap } from '../../../../lib/settings-map';
import {
  cancelInvoiceRecord, issuerChain, createInvoiceRecord, creditInvoiceInFull, finaliseInvoiceRecord,
  issueInvoiceDocument, markIssuedExternally, registeredInvoiceIssuers, type InvoiceFailure,
} from '../../../../lib/commerce/invoice-records';
import {
  documentState, invoiceDocumentsOf, resolveInvoiceSettings,
} from '../../../../lib/commerce/invoice-records-rules';
import type { InvoiceDocument } from '../../../../core/models';

/**
 * `/api/orders/{id}/invoice-records` — the order's invoice and credit-memo
 * RECORDS (non-fiscal; see lib/commerce/invoice-records.ts).
 *
 *  GET   the records, each with its `state`, and which issuer is in use
 *  POST  { action, record_id?, finalise?, number? }:
 *          create              a record by hand (`finalise: true` for final)
 *          finalise            a draft
 *          cancel              a draft
 *          credit              a final record in full (a correction; no money moves)
 *          issued_externally   it was issued elsewhere (`number` optional)
 *          issue               send it to the issuer again after a failure
 *
 * There is no "edit": a final record is immutable, and a correction is a
 * credit memo plus a new record. Staff only; the buyer reaches a record's PDF
 * through the receipt token, never this route.
 */
export const prerender = false;

const ACTIONS = ['create', 'finalise', 'cancel', 'credit', 'issued_externally', 'issue'] as const;
type Action = (typeof ACTIONS)[number];

/** Each record with the one-word state the admin shows. */
const withState = (docs: InvoiceDocument[]) => docs.map((d) => ({ ...d, state: documentState(d) }));

function failure(f: InvoiceFailure): Response {
  if (f.code === 'not_found') return ApiResponseBuilder.notFound(f.message.replace(/ not found$/, ''));
  return ApiResponseBuilder.error(409, f.message, undefined, { code: `invoice_records.${f.code}` });
}

async function issuerInfo() {
  const map = settingsMap((await LocalDB.getSettings()) as { key: string; value: unknown }[]);
  const settings = resolveInvoiceSettings(map);
  const chain = issuerChain(settings, registeredInvoiceIssuers(map));
  return {
    record_on: settings.recordOn,
    issuer: chain.kind === 'chain' ? { id: chain.issuers[0].id, label: chain.issuers[0].label } : null,
    // Who is asked, in order: the next only when the one before declines.
    issuer_chain: chain.kind === 'chain' ? chain.issuers.map((i) => ({ id: i.id, label: i.label })) : [],
    ...(chain.kind === 'problem' ? { issuer_problem: chain.message } : {}),
  };
}

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canReadCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot view orders');
    await LocalDB.init();
    const order = await LocalDB.getOrder(params.id!);
    if (!order) return ApiResponseBuilder.notFound('Order');
    return ApiResponseBuilder.success({ id: order.id, records: withState(invoiceDocumentsOf(order)), ...(await issuerInfo()) });
  } catch (err) {
    console.error('Invoice records get error:', err);
    return ApiResponseBuilder.serverError('Failed to load the invoice records');
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    // Admin only, like a refund: these act toward a tax authority (issue,
    // credit) and the plan names the verb an administrator's.
    if (user.role !== 'admin') return ApiResponseBuilder.forbidden('Only an administrator may change invoice records');
    await LocalDB.init();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return ApiResponseBuilder.error(422, 'Send a JSON object, e.g. { "action": "create", "finalise": true }', undefined, { code: 'invoice_records.invalid' });
    }
    const action = (body.action ?? 'create') as Action;
    if (!ACTIONS.includes(action)) {
      return ApiResponseBuilder.error(422, `action must be one of: ${ACTIONS.join(', ')}`, undefined, { code: 'invoice_records.invalid' });
    }
    const recordId = typeof body.record_id === 'string' ? body.record_id : '';
    if (action !== 'create' && !recordId) {
      return ApiResponseBuilder.error(422, `"${action}" needs a record_id`, undefined, { code: 'invoice_records.invalid' });
    }
    if (body.finalise !== undefined && typeof body.finalise !== 'boolean') {
      return ApiResponseBuilder.error(422, 'finalise must be true or false', undefined, { code: 'invoice_records.invalid' });
    }
    if (body.number !== undefined && (typeof body.number !== 'string' || body.number.length > 100 || /[<>]/.test(body.number))) {
      return ApiResponseBuilder.error(422, 'number must be plain text of at most 100 characters', undefined, { code: 'invoice_records.invalid' });
    }
    const id = params.id!;
    const audit = (changed: boolean, record: string) => {
      if (!changed) return;
      recordAudit(AUDIT.INVOICE_RECORD, { actor: user.id, ip: locals.ip, target: id, metadata: { action, record } });
    };

    let status = 200;
    let record: unknown;
    let changed = false;
    switch (action) {
      case 'create': {
        const r = await createInvoiceRecord(id, { finalise: body.finalise === true });
        if (!r.ok) return failure(r);
        record = r.value.record;
        changed = r.changed;
        if (r.value.created) status = 201;
        break;
      }
      case 'finalise': {
        const r = await finaliseInvoiceRecord(id, recordId);
        if (!r.ok) return failure(r);
        record = r.value.record;
        changed = r.changed;
        break;
      }
      case 'cancel': {
        const r = await cancelInvoiceRecord(id, recordId);
        if (!r.ok) return failure(r);
        record = r.value;
        changed = r.changed;
        break;
      }
      case 'credit': {
        const r = await creditInvoiceInFull(id, recordId);
        if (!r.ok) return failure(r);
        record = r.value;
        changed = r.changed;
        if (r.changed) status = 201;
        break;
      }
      case 'issued_externally': {
        const r = await markIssuedExternally(id, recordId, user.id, typeof body.number === 'string' ? body.number : undefined);
        if (!r.ok) return failure(r);
        record = r.value;
        changed = r.changed;
        break;
      }
      case 'issue': {
        const r = await issueInvoiceDocument(id, recordId);
        if (!r.ok) return failure(r);
        changed = r.called;
        break;
      }
    }
    audit(changed, (record as { id?: string } | undefined)?.id ?? recordId);

    const order = await LocalDB.getOrder(id);
    const records = withState(invoiceDocumentsOf(order));
    const recId = (record as { id?: string } | undefined)?.id ?? recordId;
    const data = { id, record: records.find((d) => d.id === recId) ?? null, records, ...(await issuerInfo()) };
    const message = changed ? 'Invoice records updated' : 'Nothing to change';
    return status === 201 ? ApiResponseBuilder.created(data, message) : ApiResponseBuilder.success(data, message);
  } catch (err) {
    console.error('Invoice records update error:', err);
    return ApiResponseBuilder.serverError('Failed to update the invoice records');
  }
};
