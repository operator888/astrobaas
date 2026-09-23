/**
 * en — admin.attention.*
 *
 * The dashboard's attention feed. Every string here frames something the
 * operator is being asked to act on, so an untranslated one is an instruction
 * in the wrong language on the screen opened most.
 *
 * Three keys per check, named after the check's own id: `.title`, `.body` and
 * `.action`. The card carries only that id and its params — there is nowhere in
 * an AttentionCard to put a sentence, which is what stops a check being written
 * with English text and no translation. tests/attention.test.mjs asserts all
 * three exist here for every registered check.
 */
export const attention = {
  'admin.attention.heading': 'What needs your attention',
  'admin.attention.allClear': 'Nothing needs your attention.',
  'admin.attention.broken': 'Needs fixing',
  'admin.attention.unfinished': 'Unfinished',
  'admin.attention.worthKnowing': 'Worth knowing',

  'admin.attention.site-url-unset.title': 'This site does not know its own address',
  'admin.attention.site-url-unset.body': 'Canonical links, the sitemap and every link in an email are built from it. Until it is set they are guessed from whatever host the request arrived on.',
  'admin.attention.site-url-unset.action': 'Set the address',

  'admin.attention.tax-origin-unset.title': 'Tax is on, but this shop has no country',
  'admin.attention.tax-origin-unset.body': 'Which country a shop sells FROM decides every rate it charges, and it is never guessed. Orders are being priced without it.',
  'admin.attention.tax-origin-unset.action': 'Set the origin country',

  'admin.attention.schema-behind.title': 'Database schema is at v{current}, this build expects v{latest}',
  'admin.attention.schema-behind.body': 'Migrations run at start-up, so this usually means one failed. Data may be read by code that expects a shape it does not have.',
  'admin.attention.schema-behind.action': 'Check background jobs',

  'admin.attention.flagged-orders.title': '{count} orders are flagged for a look',
  'admin.attention.flagged-orders.body': 'The risk signals never refuse an order — they only ask for a human. These are still open.',
  'admin.attention.flagged-orders.action': 'Review them',

  'admin.attention.active-out-of-stock.title': '{count} products are listed but out of stock',
  'admin.attention.active-out-of-stock.body': 'Shoppers can reach them and cannot buy them. Deliberate if you take backorders; otherwise they are dead ends in the catalogue.',
  'admin.attention.active-out-of-stock.action': 'Open the catalogue',

  'admin.attention.overdue-scheduled-posts.title': '{count} scheduled posts did not publish',
  'admin.attention.overdue-scheduled-posts.body': 'Their publish date has passed and they are still scheduled. Whoever wrote them believes they are live.',
  'admin.attention.overdue-scheduled-posts.action': 'Open posts',

  'admin.attention.brand-spellings.title': '{count} brands need a decision about their spelling',
  'admin.attention.brand-spellings.body': 'Shoppers are unaffected — filtering already treats these as one maker. These are the ones no rule could safely decide for you.',
  'admin.attention.brand-spellings.action': 'Open the catalogue',

  'admin.attention.assistant-error.title': 'The AI assistant last returned an error',
  'admin.attention.assistant-error.body': 'A key may have expired, been revoked, or run out of credit. {provider} said: “{detail}”',
  'admin.attention.assistant-error.action': 'Check the settings',

  'admin.attention.orders-need-refund.title': '{count} orders were paid for after they were cancelled',
  'admin.attention.orders-need-refund.body': 'The payment arrived after the order had been cancelled and its items sold, so nothing will ship. Refund these customers, or restock the items and reopen the orders.',
  'admin.attention.orders-need-refund.action': 'Open orders',

  'admin.attention.payment-return-urls.title': 'Paying customers would be sent back to a page that does not exist',
  'admin.attention.payment-return-urls.body': 'After paying by card, PayPal or Klarna, buyers return to the Site URL — which is empty, or is the address of this CMS rather than your storefront.',
  'admin.attention.payment-return-urls.action': 'Set the Site URL',
};
