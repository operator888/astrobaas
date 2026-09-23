/**
 * en — admin.orders.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * The status and payment labels below are LABELS ONLY. The values they describe
 * ('pending', 'on-hold', …) are the API's vocabulary and stay in the `value=`
 * attribute and the data-* attributes, untranslated — the select still posts
 * `on-hold` however the option reads.
 */
export const orders = {
  'admin.orders.title': 'Orders',
  'admin.orders.subtitle': 'Customer orders and fulfilment',
  'admin.orders.statTotal': 'Total orders',
  'admin.orders.statOpen': 'Open (pending / processing)',
  'admin.orders.statRevenue': 'Completed revenue',
  'admin.orders.empty': 'No orders yet.',

  // Fulfilment status — one label per ORDER_STATUSES value.
  'admin.orders.statusPending': 'pending',
  'admin.orders.statusProcessing': 'processing',
  'admin.orders.statusOnHold': 'on hold',
  'admin.orders.statusCompleted': 'completed',
  'admin.orders.statusCancelled': 'cancelled',
  'admin.orders.statusRefunded': 'refunded',
  'admin.orders.statusFailed': 'failed',

  // Payment status — tracked separately from fulfilment.
  'admin.orders.paymentPaid': '✓ paid',
  'admin.orders.paymentPending': '⋯ awaiting payment',
  'admin.orders.paymentFailed': '✕ payment failed',
  'admin.orders.paymentRefunded': '↩ refunded',
  'admin.orders.paymentUnpaid': 'unpaid',

  'admin.orders.methodBankTransfer': '🏦 bank transfer',
  'admin.orders.prescription': 'Rx',
  'admin.orders.prescriptionDelete': 'delete',
  'admin.orders.trackingCarrier': 'Carrier',
  'admin.orders.trackingNumber': 'Tracking number',
  'admin.orders.trackingSend': 'Save & notify',
  'admin.orders.trackingUpdate': 'Update tracking',
  'admin.orders.trackingFailed': 'Could not save the tracking details.',
  'admin.orders.shippedOn': 'Shipped {date}',
  'admin.orders.staffNotePlaceholder': 'Shop note — not shown to the customer',
  'admin.orders.staffNoteFailed': 'Could not save the note.',
  'admin.orders.prescriptionDeleteConfirm': 'Permanently delete the prescription on order {number}? This is health data the system keeps through a customer erasure on purpose — delete it only when your retention period has passed. It cannot be undone.',
  'admin.orders.prescriptionDeleteFailed': 'Could not delete the prescription.',
  'admin.orders.note': 'Note: {note}',

  'admin.orders.refundedAmount': '−{amount} refunded',
  'admin.orders.refundRemaining': '{amount} left',
  'admin.orders.statusLocked': 'Your role can view orders but not change their status. An administrator or editor can.',
  'admin.orders.refund': 'Refund…',
  'admin.orders.refundInProviderDashboard': 'Refund in the {provider} dashboard',

  // Flags the payment path and checkout set on an order (hardening step 4).
  'admin.orders.needsRefund': 'Needs refund — paid after it was cancelled, stock gone',
  'admin.orders.declines': 'Declined card attempts: {count}',
  'admin.orders.riskHeld': 'On hold for review (risk)',
  'admin.orders.riskFlagged': 'Risk flagged',
  'admin.orders.holdExpired': 'Payment time ran out',

  // Browser-side (window.t): no plural support, so nothing here takes a count.
  'admin.orders.updateFailed': 'Update failed',
  'admin.orders.refundPromptTitle': 'Refund order {number} via {provider}.',
  'admin.orders.refundPromptMax': 'Up to {amount} {currency} can be returned.',
  'admin.orders.refundPromptEnter': 'Enter an amount, or leave blank to refund all {amount} {currency}.',
  'admin.orders.amountInvalid': 'Enter a positive amount.',
  'admin.orders.amountTooHigh': 'That is more than the {amount} {currency} still refundable.',
  'admin.orders.refundFullAmount': '{amount} {currency} (full)',
  'admin.orders.refundConfirm': 'Send {amount} back to the customer? This cannot be undone from here.',
  'admin.orders.refunding': 'Refunding…',
  'admin.orders.refundFailed': 'Refund failed',
};

export default orders;
