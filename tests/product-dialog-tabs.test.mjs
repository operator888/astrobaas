#!/usr/bin/env node
/**
 * The product dialog's tabs: every block of fields belongs to exactly one tab.
 *
 * The tab switcher hides each `.tab-panel` whose `data-panel` is not the
 * chosen tab. A `<section>` without that class is never hidden, so its fields
 * show under EVERY tab — that is how "Requires a prescription" ended up on
 * General, Images, Variants, Inventory, Shipping, Safety and Advanced at once.
 *
 * Static rules on src/pages/admin/products.astro:
 *   1. every <section> inside the dialog is a `tab-panel` with a `data-panel`;
 *   2. every `data-panel` has a tab button, and every tab button a panel;
 *   3. the prescription fields sit in the Safety panel, once.
 *
 * Run with:  node tests/product-dialog-tabs.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src/pages/admin/products.astro'), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
};

const start = src.indexOf('<dialog id="product-dialog"');
const end = src.indexOf('</dialog>', start);
check('the product dialog is found', start > 0 && end > start);
const dialog = src.slice(start, end);

// 1. Every section is a tab panel.
const sections = [...dialog.matchAll(/<section\b([^>]*)>/g)].map((m) => m[1]);
check('the dialog has sections', sections.length >= 8, `${sections.length}`);
const loose = sections.filter((a) => !/\bclass="[^"]*\btab-panel\b/.test(a) || !/\bdata-panel="[^"]+"/.test(a));
check('every section is a tab-panel with a data-panel (else it shows under every tab)',
  loose.length === 0, loose.map((a) => a.trim()).join(' | '));

// 2. Panels and buttons match.
const panels = new Set(sections.map((a) => a.match(/\bdata-panel="([^"]+)"/)?.[1]).filter(Boolean));
const tabs = new Set([...dialog.matchAll(/\bdata-tab="([^"]+)"/g)].map((m) => m[1]));
const noButton = [...panels].filter((p) => !tabs.has(p));
const noPanel = [...tabs].filter((t) => !panels.has(t));
check('every panel has a tab button', noButton.length === 0, noButton.join(', '));
check('every tab button has a panel', noPanel.length === 0, noPanel.join(', '));

// 3. The prescription fields: once, in Safety.
function panelOf(needle) {
  const at = dialog.indexOf(needle);
  if (at < 0) return null;
  const open = dialog.lastIndexOf('<section', at);
  const close = dialog.lastIndexOf('</section>', at);
  if (open < 0 || close > open) return 'outside any section';
  return dialog.slice(open, dialog.indexOf('>', open)).match(/\bdata-panel="([^"]+)"/)?.[1] ?? 'no data-panel';
}
for (const field of ['name="requires_prescription"', 'name="prescription_type"']) {
  check(`${field} appears once`, dialog.split(field).length === 2);
  check(`${field} is in the Safety tab`, panelOf(field) === 'safety', String(panelOf(field)));
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nproduct dialog tabs: all checks passed');
