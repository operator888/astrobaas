#!/usr/bin/env node
/**
 * Email wording (C-112), subscriber events for an ESP (C-113), and the opt-in
 * overlay (C-114).
 *
 * Each of these is easy to ship as a hazard. Editable emails are the ability to
 * write a phishing message in the site's own voice and to delete the link that
 * makes a password reset work. An ESP integration that forwards signups but not
 * unsubscribes ends in spam complaints. A popup with no frequency cap is the
 * pattern every reader has learned to close unread.
 *
 * Run with:  node tests/marketing.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const T = await loadTs('src/lib/email-templates.ts');
const P = await loadTs('src/lib/popups.ts');
const W = await loadTs('src/lib/webhook-util.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
const tplRoute = await read('src/pages/api/email-templates.ts');
const popupScript = await read('src/pages/popup.js.ts');
const popupPlugin = await read('src/plugins/popups/index.ts');
const confirmRoute = await read('src/pages/api/newsletter/confirm.ts');
const unsubRoute = await read('src/pages/api/newsletter/unsubscribe.ts');
const submissionNotify = await read('src/lib/submission-notify.ts');
const newsletterRoute = await read('src/pages/api/newsletter.ts');
const orderConfirm = await read('src/lib/commerce/order-confirmation.ts');
const baseLayout = await read('src/layouts/BaseLayout.astro');
const forgot = await read('src/pages/api/auth/forgot.ts');
const magic = await read('src/pages/api/auth/magic-link.ts');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function code(src) {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\s\*).*$/gm, '');
}

/* ═══════════════════════════ C-112 · email wording ════════════════════════ */

const reset = T.getEmailTemplate('password_reset');

check('every template is complete and its defaults are valid by its own rules', () => {
  // A shipped default that the save endpoint would refuse is a template nobody
  // can edit without first breaking it.
  for (const def of T.EMAIL_TEMPLATES) {
    ok(def.label && def.when, `${def.id}: no label or explanation`);
    const problem = T.templateProblem(def, { subject: def.defaultSubject, body: def.defaultBody });
    ok(problem === null, `${def.id}: its own default is invalid — ${problem}`);
  }
});

check('THE REQUIRED PLACEHOLDER CANNOT BE REMOVED', () => {
  // A password reset without its link sends, looks fine, and is useless — a
  // support ticket the operator cannot see coming.
  const problem = T.templateProblem(reset, { subject: 'Reset', body: 'Hello, please reset your password.' });
  ok(problem && /reset_link/.test(problem), String(problem));
});

check('A REQUIRED PLACEHOLDER MUST BE IN THE BODY, not the subject', () => {
  // The first version accepted either, which was worse than useless: it let an
  // operator save a reset whose body says "contact support" and whose SUBJECT
  // carries the live token — into MTA logs, notification previews and
  // lock-screen banners, where a subject travels furthest and is logged most.
  const problem = T.templateProblem(reset, { subject: 'Reset: {{reset_link}}', body: 'Hello.' });
  ok(problem, 'a body with no link was accepted because the subject had one');
  ok(/message/.test(problem), problem);
});

check('...and a SECRET in the subject is refused outright', () => {
  const problem = T.templateProblem(reset, { subject: 'Reset: {{reset_link}}', body: 'Go: {{reset_link}}' });
  ok(problem && /subject/.test(problem), String(problem));
  ok(/lock screen/.test(problem ?? ''), `it does not say why: ${problem}`);
  // The same rule for every template that carries one.
  for (const id of ['magic_link', 'newsletter_confirm']) {
    const def = T.getEmailTemplate(id);
    const req = def.required[0];
    ok(T.templateProblem(def, { subject: `Hi {{${req}}}`, body: `Go {{${req}}}` }), `${id} allows its link in the subject`);
  }
});

check('a NON-secret placeholder in the subject is fine', () => {
  // `{{order_number}}` in a subject is what a customer searches their inbox
  // for. The rule is about secrets, not about placeholders.
  ok(T.templateProblem(T.getEmailTemplate('order_confirmation'),
    { subject: 'Your order {{order_number}}', body: '' }) === null);
});

check('an unknown placeholder is refused, and the message LISTS the real ones', () => {
  // "Invalid template" is a message an operator can only respond to by giving
  // up.
  const problem = T.templateProblem(reset, { subject: 'Hi', body: '{{reset_link}} {{customer_iban}}' });
  ok(problem && /customer_iban/.test(problem), String(problem));
  ok(problem && /reset_link/.test(problem) && /site_title/.test(problem), `it does not list what IS available: ${problem}`);
});

check('A LINE BREAK IN THE SUBJECT IS REFUSED', () => {
  // The subject is a header, and this is an operator-supplied string.
  ok(T.templateProblem(reset, { subject: 'Reset\nBcc: evil@example.com', body: '{{reset_link}}' }));
});

check('...and a value containing one is flattened at render', () => {
  // The other half: the operator's subject is fine and the FILLED value is not.
  const out = T.renderEmailTemplate('order_confirmation', {
    site_title: 'Shop\nBcc: evil@example.com',
    order_number: 'A-1',
  });
  ok(!/[\r\n]/.test(out.subject), JSON.stringify(out.subject));
});

check('empty is not a template', () => {
  ok(T.templateProblem(reset, { subject: '', body: '{{reset_link}}' }));
  ok(T.templateProblem(reset, { subject: 'Reset', body: '' }));
});

check('an override is used when it is valid', () => {
  const out = T.renderEmailTemplate('password_reset',
    { site_title: 'Οπτική Γωνία', reset_link: 'https://x/y', expires_in: 'μία ώρα' },
    { subject: 'Νέος κωδικός για {{site_title}}', body: 'Πατήστε: {{reset_link}}' });
  eq(out.subject, 'Νέος κωδικός για Οπτική Γωνία');
  eq(out.text, 'Πατήστε: https://x/y');
  eq(out.customised, true);
});

check('AN UNUSABLE STORED TEMPLATE FALLS BACK — it does not send something broken', () => {
  // A template written before a placeholder was renamed would otherwise send a
  // customer `{{order_no}}` verbatim, or a reset with no link at all.
  const out = T.renderEmailTemplate('password_reset',
    { reset_link: 'https://x/y' },
    { subject: 'Reset', body: 'No link here at all.' });
  ok(out.text.includes('https://x/y'), out.text);
  eq(out.customised, false, 'it used the broken override');
});

check('a stored template that arrives as a STRING still works', () => {
  // The relational driver stores settings as TEXT, so an object comes back as
  // its JSON. Three features here have been bitten by exactly this.
  const out = T.renderEmailTemplate('password_reset',
    { reset_link: 'https://x/y' },
    JSON.stringify({ subject: 'Custom', body: 'Go: {{reset_link}}' }));
  eq(out.subject, 'Custom');
  eq(out.customised, true);
});

check('junk in the settings row does not take the email down', () => {
  for (const junk of [null, 42, [], 'not json', '{"broken":', {}]) {
    const out = T.renderEmailTemplate('password_reset', { reset_link: 'https://x/y' }, junk);
    ok(out && out.text.includes('https://x/y'), `${JSON.stringify(junk)} → ${JSON.stringify(out)}`);
  }
});

check('an unfilled placeholder becomes nothing, not braces in a customer inbox', () => {
  const out = T.renderEmailTemplate('order_confirmation', { order_number: 'A-1' });
  ok(!/\{\{/.test(out.subject + out.text), out.subject + out.text);
});

check('THE SUBJECT-ONLY TEMPLATE KEEPS ITS BUILT-IN BODY', () => {
  // The order confirmation's body is an itemised document with a plain-text and
  // an HTML rendering that have to agree.
  const order = T.getEmailTemplate('order_confirmation');
  ok(order.subjectOnly === true);
  const out = T.renderEmailTemplate('order_confirmation',
    { order_number: 'A-1', site_title: 'Shop' },
    { subject: 'Your order {{order_number}}', body: 'REPLACED ENTIRELY' });
  eq(out.subject, 'Your order A-1', 'the subject override was ignored');
  ok(!out.text.includes('REPLACED ENTIRELY'), 'the body override was used');
});

check('...and an empty body is fine for it, while it is not for the others', () => {
  ok(T.templateProblem(T.getEmailTemplate('order_confirmation'), { subject: 'Order {{order_number}}', body: '' }) === null);
  ok(T.templateProblem(T.getEmailTemplate('magic_link'), { subject: 'Hi', body: '' }));
});

check('ADMIN ONLY — rewording these is the ability to phrase a phishing email', () => {
  const src = code(tplRoute);
  for (const verb of ['GET', 'PUT', 'DELETE']) {
    const from = src.indexOf(`export const ${verb}: APIRoute`);
    ok(from >= 0, `no ${verb}`);
    const rest = src.slice(from + 10);
    const next = rest.indexOf('export const ');
    const body = next < 0 ? rest : rest.slice(0, next);
    ok(/isAdmin\(locals\)/.test(body), `${verb} is not admin-gated`);
  }
});

check('the save validates with the SAME function the renderer validates with', () => {
  ok(/templateProblem\(def, edit\)/.test(code(tplRoute)), 'the endpoint has its own rules');
});

check('RESET CLEARS rather than storing a copy of the default', () => {
  // Storing the built-in wording means a later improvement to it never reaches
  // this install.
  ok(/updateSetting\(emailTemplateKey\(def\.id\), null\)/.test(code(tplRoute)), 'reset writes a copy');
});

check('EVERY sender actually uses its template', () => {
  // The row is "admin-editable templates". A registry nothing reads is a
  // settings screen that does nothing.
  //
  // All five, not the two that share a helper. The other three read the
  // setting themselves, and an audit made `newsletter-confirm` pass `undefined`
  // instead of the stored override — silently ignoring the operator's wording —
  // with this file green.
  ok(/renderStoredTemplate\('password_reset'/.test(code(forgot)), 'the password reset ignores it');
  ok(/renderStoredTemplate\('magic_link'/.test(code(magic)), 'the sign-in link ignores it');
  ok(/renderStoredTemplate\('submission_notice'/.test(code(submissionNotify)), 'the submission notice ignores it');
  // The newsletter confirmation takes the override as an ARGUMENT, so the check
  // is that the caller passes it — not that the function mentions it.
  ok(/emailTemplateKey\('newsletter_confirm'\)/.test(code(newsletterRoute)), 'the newsletter route never reads the override');
  ok(/confirmEmail\([\s\S]{0,200}?tpl,?\s*\)/.test(code(newsletterRoute)), 'the newsletter route reads it and does not pass it');
  ok(/renderEmailTemplate\('order_confirmation'/.test(code(orderConfirm)), 'the order confirmation ignores it');
});

/* ═══════════════════════════ C-113 · subscriber events ════════════════════ */

check('the newsletter events exist at all', () => {
  // The old roadmap note claimed webhooks covered 80% of ESP sync. They covered
  // none of it: there was no subscriber event of any kind.
  ok(W.WEBHOOK_EVENTS.includes('subscriber.confirmed'), W.WEBHOOK_EVENTS.join(', '));
  ok(W.WEBHOOK_EVENTS.includes('subscriber.unsubscribed'), W.WEBHOOK_EVENTS.join(', '));
});

check('there is NO event for an unconfirmed signup', () => {
  // An ESP receiving that would be importing an address nobody consented with.
  ok(!W.WEBHOOK_EVENTS.some((e) => e === 'subscriber.created' || e === 'subscriber.signup'),
    W.WEBHOOK_EVENTS.filter((e) => e.startsWith('subscriber')).join(', '));
});

check('confirmed fires on the double-opt-in click, and only the FIRST time', () => {
  const src = code(confirmRoute);
  ok(/fireEvent\('subscriber\.confirmed'/.test(src), 'nothing fires on confirmation');
  // Inside the `if (!already)` branch: a link clicked twice, or a prefetching
  // mail client, must not re-import the address.
  const branch = src.slice(src.indexOf('if (!already)'), src.indexOf('const leave'));
  ok(/fireEvent\('subscriber\.confirmed'/.test(branch), 'it fires on every click, not just the first');
});

check('THE UNSUBSCRIBE FIRES — the event that must reach the ESP', () => {
  // An unsubscribe this site honours and Mailchimp does not ends in a spam
  // complaint, which is why confirm-only would be worse than nothing.
  ok(/fireEvent\('subscriber\.unsubscribed'/.test(code(unsubRoute)), 'leaving is not forwarded');
});

check('...once per person, not once per duplicate row', () => {
  // Sliced to the LOOP BODY by its braces, not "up to the first fireEvent" —
  // the first version of this check ended the slice at the very call it was
  // looking for, so it examined an empty string and passed on code that fired
  // inside the loop.
  // COUNTED, not sliced. The slice ended at the first `}` after the loop's
  // `{`, so wrapping the delete in braces and firing inside hid the event from
  // it — the second version of this check, defeated by one level of nesting.
  // The property is "exactly one event per person", and a count says that
  // directly.
  const src = code(unsubRoute);
  ok(src.includes('for (const m of matches)'), 'no delete loop');
  const fires = (src.match(/fireEvent\('subscriber\.unsubscribed'/g) ?? []).length;
  ok(fires === 1, `${fires} unsubscribe events in this route — it fires per row, not per person`);
});

check('...AND IT FIRES EVEN WHEN THE ROW IS ALREADY GONE', () => {
  // This test previously asserted the OPPOSITE — `if (matches.length)` — which
  // looked tidy and was the named failure. The reader clicks unsubscribe, the
  // row goes, the webhook delivery to the ESP fails, they keep receiving ESP
  // mail, they click the link in the NEXT message: no row, so no event, so they
  // are permanently un-removable from the ESP. An unsubscribe is idempotent at
  // every ESP, so a duplicate costs nothing and a missing one costs a spam
  // complaint.
  const src = code(unsubRoute);
  ok(!/if \(matches\.length\)[\s\S]{0,120}fireEvent/.test(src), 'the event is gated on a row existing');
  ok(/void fireEvent\('subscriber\.unsubscribed'/.test(src), 'leaving is not forwarded at all');
});

check('neither send blocks on the delivery', () => {
  // Somebody must not fail to leave a list because an automation endpoint is
  // down.
  for (const [what, src] of [['confirm', confirmRoute], ['unsubscribe', unsubRoute]]) {
    ok(/void fireEvent/.test(code(src)), `${what} awaits the webhook`);
  }
});

/* ═══════════════════════════ C-114 · the popup ════════════════════════════ */

check('a popup with no words is not a popup', () => {
  // An operator who ticked the box and never wrote the text would otherwise get
  // an empty grey rectangle over their article.
  ok(!P.popupIsShowable(P.resolvePopup({ popup_enabled: true })));
  ok(!P.popupIsShowable(P.resolvePopup({ popup_enabled: true, popup_title: 'Hi' })));
  ok(P.popupIsShowable(P.resolvePopup({ popup_enabled: true, popup_title: 'Hi', popup_text: 'Join us' })));
});

check('off is off, through TEXT storage too', () => {
  ok(!P.resolvePopup({}).enabled);
  ok(!P.resolvePopup({ popup_enabled: 'false' }).enabled, 'the string "false" is truthy in JS');
  // The reader used to be a hand-rolled `=== true || === 'true'`, which covered
  // ONE affirmative and NO negatives — so "0" and "off" both switched the popup
  // on. It is settingBool now, so the whole vocabulary works both ways.
  ok(P.resolvePopup({ popup_enabled: 'true' }).enabled, 'the string "true" enables it');
  ok(P.resolvePopup({ popup_enabled: '1' }).enabled, '"1" enables it');
  ok(P.resolvePopup({ popup_enabled: 'on' }).enabled, '"on" enables it');
  ok(!P.resolvePopup({ popup_enabled: '0' }).enabled, '"0" does NOT enable it');
  ok(!P.resolvePopup({ popup_enabled: 'off' }).enabled, '"off" does NOT enable it');
  ok(!P.resolvePopup({ popup_enabled: 'banana' }).enabled, 'nonsense does not enable it');
  ok(!P.resolvePopup({ popup_enabled: false }).enabled);
  ok(P.resolvePopup({ popup_enabled: 'true' }).enabled);
});

check('AN UNSET NUMBER IS ITS DEFAULT, NOT ITS MINIMUM', () => {
  // `Number('')` is 0, which is finite — so the first version of `int()` fell
  // through its NaN check and clamped an ABSENT setting to the floor. Every
  // default in this module was silently its own minimum: a fresh install would
  // have shown the popup after one second, at 5% scroll, every single day —
  // the exact opposite of the frequency cap the module exists to provide.
  //
  // Invisible in the code, obvious in a screenshot of the settings form.
  const fresh = P.resolvePopup({});
  eq(fresh.delaySeconds, 15, 'delay');
  eq(fresh.scrollPercent, 50, 'scroll');
  eq(fresh.frequencyDays, 14, 'frequency');
  // An EMPTY setting row is the same as no row — an operator who cleared the
  // box means "use the default", not "use the minimum".
  const cleared = P.resolvePopup({ popup_delay_seconds: '', popup_scroll_percent: '  ', popup_frequency_days: null });
  eq(cleared.delaySeconds, 15, 'cleared delay');
  eq(cleared.scrollPercent, 50, 'cleared scroll');
  eq(cleared.frequencyDays, 14, 'cleared frequency');
});

check('EVERY NUMBER IS BOUNDED — these reach a timer in a reader\'s browser', () => {
  const wild = P.resolvePopup({
    popup_delay_seconds: '-1', popup_scroll_percent: '1e9', popup_frequency_days: '0',
  });
  ok(wild.delaySeconds >= 1, wild.delaySeconds);
  ok(wild.scrollPercent <= 100, wild.scrollPercent);
  // Zero days would mean "every page view", which is the pattern this exists to
  // avoid.
  ok(wild.frequencyDays >= 1, wild.frequencyDays);
});

check('an unknown trigger falls back rather than disabling the popup silently', () => {
  eq(P.resolvePopup({ popup_trigger: 'telepathy' }).trigger, 'delay');
  eq(P.resolvePopup({ popup_trigger: 'SCROLL' }).trigger, 'scroll');
});

check('THE FREQUENCY CAP', () => {
  const day = 86400000;
  const now = 1_700_000_000_000;
  ok(P.popupShouldShow(null, 14, now), 'a first visit');
  ok(!P.popupShouldShow({ seen: now - day }, 14, now), 'shown yesterday');
  ok(P.popupShouldShow({ seen: now - 15 * day }, 14, now), 'shown fifteen days ago');
  ok(P.popupShouldShow({ seen: now - 14 * day }, 14, now), 'exactly at the boundary');
});

check('SOMEBODY WHO SIGNED UP IS NEVER ASKED AGAIN', () => {
  // The single most common complaint about these things, and entirely
  // avoidable.
  ok(!P.popupShouldShow({ done: true }, 14, Date.now()));
  ok(!P.popupShouldShow({ done: true, seen: 0 }, 1, Date.now()), 'even long after the cap expired');
});

check('a clock that moved backwards does not unlock it', () => {
  const now = 1_700_000_000_000;
  ok(!P.popupShouldShow({ seen: now + 86400000 }, 14, now), 'a future timestamp');
});

check('an unreadable store shows it ONCE rather than never', () => {
  ok(P.popupShouldShow({ seen: 'nonsense' }, 14, Date.now()));
  ok(P.popupShouldShow({}, 14, Date.now()));
});

check('the payload carries no switch — only what the browser renders', () => {
  const payload = P.popupPayload(P.resolvePopup({ popup_enabled: true, popup_title: 'Hi', popup_text: 'x' }));
  ok(!('enabled' in payload), Object.keys(payload).join(', '));
  eq(P.popupPayload(P.resolvePopup({})), null, 'a disabled popup still produced a payload');
});

check('the browser NEVER builds the copy with innerHTML', () => {
  // This is operator-authored text on every public page; innerHTML here would
  // make the settings form an XSS vector.
  const src = code(popupScript);
  ok(!/innerHTML/.test(src), 'the served script uses innerHTML');
  ok(/textContent/.test(src), 'nothing sets text at all');
});

check('it does not cover the page, and Escape closes it', () => {
  // A modal that blocks the article until you hand over an address is the shape
  // regulators have fined and readers bounce from.
  ok(/aria-modal', 'false'/.test(popupScript), 'it claims to be modal');
  ok(/Escape/.test(popupScript), 'Escape does not close it');
  ok(!/position:fixed;inset:0|width:100vw;height:100vh/.test(popupPlugin), 'the CSS covers the viewport');
});

check('IT NEVER STACKS ON THE CONSENT BANNER', () => {
  // A reader being asked about cookies is already interrupted; two overlays
  // means both get dismissed unread.
  ok(/consentDecided/.test(popupScript), 'it does not wait for a consent decision');
  ok(/waits > 20/.test(popupScript), 'it waits forever — a page open for an hour keeps polling');
});

check('exit intent falls back on a touch screen', () => {
  // Otherwise the popup never appears on half the traffic and the operator has
  // no way to find out why.
  ok(/hover: hover/.test(popupScript), 'no pointer capability check');
});

check('ONE liveness rule, asked by the layout and by the script', () => {
  // The assistant needed a module for exactly this after the tag and the
  // payload disagreed.
  ok(/popupsAreLive\(\)/.test(code(baseLayout)), 'the layout decides for itself');
  ok(/popupsAreLive\(\)/.test(code(popupScript)), 'the script decides for itself');
});

check('...and the popup never loads on an admin page', () => {
  ok(/startsWith\('\/admin'\)/.test(code(baseLayout)), 'a popup could appear over the editor');
});

check('it is a PLUGIN, so an install that never asked carries nothing', () => {
  ok(/id: 'popups'/.test(popupPlugin), 'no plugin id');
  ok(/status: 404/.test(popupScript), 'the script is served even when the plugin is off');
});

if (failures.length) {
  console.error(`\n✗ marketing: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ marketing: ${passed} passed`);
