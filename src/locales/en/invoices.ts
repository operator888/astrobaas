/**
 * en — admin.invoices.*
 *
 * The invoice and credit-memo RECORDS shown on each order, and Settings →
 * Invoices. "Record", never "invoice", wherever no issuer issued it: AstroBaaS
 * is not a fiscal device, and the internal reference is not an invoice number.
 */
export const invoices = {
  'admin.invoices.heading': 'Invoice records',
  'admin.invoices.none': 'No invoice record yet.',
  'admin.invoices.kindInvoice': 'Invoice record',
  'admin.invoices.kindMemo': 'Credit memo',
  'admin.invoices.stateDraft': 'Draft',
  'admin.invoices.stateFinal': 'Final',
  'admin.invoices.stateCancelled': 'Cancelled',
  'admin.invoices.stateIssuing': 'Being issued',
  'admin.invoices.stateIssued': 'Issued',
  'admin.invoices.stateIssueFailed': 'Issue failed',
  'admin.invoices.stateIssuedElsewhere': 'Issued elsewhere',
  'admin.invoices.issuerNumber': 'Document no. {number}',
  'admin.invoices.externalNumber': 'Elsewhere as {number}',
  'admin.invoices.internalReference': 'Internal ref. {ref} (not an invoice number)',
  'admin.invoices.credits': 'credits {id}',
  'admin.invoices.vatIncomplete': 'No reconciled VAT breakdown on this order',
  'admin.invoices.pdf': 'PDF',
  'admin.invoices.create': 'Create record',
  'admin.invoices.createFinal': 'Create final record',
  'admin.invoices.finalise': 'Finalise',
  'admin.invoices.cancel': 'Cancel draft',
  'admin.invoices.credit': 'Credit in full',
  'admin.invoices.markExternal': 'Issued elsewhere…',
  'admin.invoices.retry': 'Send to issuer again',
  'admin.invoices.notTaxDocument': 'No issuer is set up: these records are not tax documents.',
  'admin.invoices.issuerInUse': 'Issued through {issuer}.',
  'admin.invoices.markExternalPrompt': 'Document number it was issued with elsewhere (optional):',
  'admin.invoices.creditConfirm': 'Credit this record in full? No money is refunded; use this to correct a record, then create a new one.',
  'admin.invoices.finaliseConfirm': 'Finalise this record? A final record can never be edited.',
  'admin.invoices.declined': 'Not issued — declined by {reasons}',
  'admin.invoices.retryAt': 'Retried automatically after {at} (attempt {n} of {max})',
  'admin.invoices.retryExhausted': 'Automatic retries used up; send it again by hand.',
  'admin.invoices.issuedLate': 'confirmed late',
  'admin.invoices.failed': 'Could not update the invoice records.',
};

export default invoices;
