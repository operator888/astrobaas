/*
 * AstroBaaS Finance — admin app.
 *
 * Plain browser JavaScript, served same-origin from /plugin-admin.js under the
 * admin's hash-based CSP (no inline script, no inline style attributes; widths
 * for charts are set through the CSSOM, which CSP allows).
 *
 * Every piece of data is written with textContent, never innerHTML: a
 * customer name is untrusted input aimed at the admin.
 */
(function () {
  'use strict';
  const API = '/api/plugin/finance';
  const root = document.getElementById('fin-app');
  if (!root) return;
  const csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || root.dataset.csrf || '';

  /* ------------------------------------------------------------------ helpers */

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'selected') el.selected = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === undefined || c === null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  async function api(method, path, body, opts = {}) {
    const headers = { 'X-CSRF-Token': csrf };
    let payload;
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      payload = body;
      headers['Content-Type'] = opts.contentType || 'application/octet-stream';
    } else if (typeof body === 'string') {
      payload = body;
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(API + path, { method, headers, body: payload, credentials: 'same-origin' });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || (json && json.success === false)) {
      const msg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json ? json.data : null;
  }

  const fmt = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (c, cur = 'EUR') => `${fmt.format((c || 0) / 100)} ${cur === 'EUR' ? '€' : cur}`;
  const date = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '—');
  const today = () => new Date().toISOString().slice(0, 10);
  const parseMoney = (s) => {
    if (typeof s === 'number') return Math.round(s * 100);
    let t = String(s || '').replace(/[\s€]/g, '');
    if (!t) return 0;
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}\.\d{3}$/.test(t) || (t.match(/\./g) || []).length > 1) t = t.replace(/\./g, ''); // "1.500" = 1500 €
    else t = t.replace(/,/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  };
  const centsInput = (c) => fmt.format((c || 0) / 100);

  /** Element.append() writes null as the text "null"; this skips it like h() does. */
  function append(el, ...children) {
    el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  }

  let toasts = null;
  function toast(msg, kind = 'ok') {
    if (!toasts || !toasts.isConnected) {
      toasts = h('div', { class: 'fixed bottom-4 right-4 z-50 flex max-w-md flex-col items-end gap-2' });
      document.body.appendChild(toasts);
    }
    const t = h('div', { class: `rounded-lg px-4 py-3 text-sm shadow-lg ${kind === 'err' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'}`, role: 'status' }, msg);
    toasts.appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
  }

  async function run(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.message || String(e), 'err');
      return undefined;
    }
  }

  const btn = (label, onclick, kind = 'secondary', extra = {}) => h('button', {
    type: 'button', onclick,
    class: {
      primary: 'inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50',
      secondary: 'inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50',
      danger: 'inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50',
      link: 'text-sm font-medium text-blue-600 hover:underline',
    }[kind], ...extra,
  }, label);

  const input = (attrs) => h('input', { class: 'block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500', ...attrs });
  const select = (attrs, options, current) => h('select', { class: 'block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm', ...attrs },
    options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(current ?? '') }, l)));
  const textarea = (attrs) => h('textarea', { class: 'block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm', rows: 3, ...attrs });
  const field = (label, control, hint) => h('label', { class: 'block' },
    h('span', { class: 'mb-1 block text-xs font-medium text-gray-600' }, label), control,
    hint ? h('span', { class: 'mt-1 block text-xs text-gray-400' }, hint) : null);
  const card = (...c) => h('div', { class: 'rounded-lg border border-gray-200 bg-white p-4 shadow-sm' }, ...c);
  const title = (t, ...actions) => h('div', { class: 'mb-4 flex flex-wrap items-center justify-between gap-2' },
    h('h2', { class: 'text-lg font-semibold text-gray-900' }, t), h('div', { class: 'flex flex-wrap gap-2' }, ...actions));

  const STATUS = {
    draft: ['Entwurf', 'bg-gray-100 text-gray-700'],
    open: ['Offen', 'bg-blue-100 text-blue-800'],
    partially_paid: ['Teilbezahlt', 'bg-amber-100 text-amber-800'],
    paid: ['Bezahlt', 'bg-green-100 text-green-800'],
    cancelled: ['Storniert', 'bg-gray-200 text-gray-600'],
    accepted: ['Angenommen', 'bg-green-100 text-green-800'],
    rejected: ['Abgelehnt', 'bg-red-100 text-red-700'],
    invoiced: ['Abgerechnet', 'bg-purple-100 text-purple-800'],
    overdue: ['Überfällig', 'bg-red-100 text-red-800'],
    unmatched: ['Offen', 'bg-amber-100 text-amber-800'],
    matched: ['Zugeordnet', 'bg-green-100 text-green-800'],
    ignored: ['Ignoriert', 'bg-gray-100 text-gray-500'],
  };
  const badge = (s) => {
    const [l, c] = STATUS[s] || [s, 'bg-gray-100 text-gray-700'];
    return h('span', { class: `inline-block rounded-full px-2 py-0.5 text-xs font-medium ${c}` }, l);
  };
  const TYPE = { invoice: 'Rechnung', quote: 'Angebot', credit_note: 'Gutschrift' };
  const TREATMENTS = [
    ['domestic', 'Inland (19 % / 7 %)'], ['small_business', 'Kleinunternehmer (§ 19 UStG)'],
    ['reverse_charge_eu', 'EU-Leistung, Reverse Charge (§ 13b)'], ['intra_community_supply', 'Innergemeinschaftliche Lieferung'],
    ['third_country_service', 'Leistung Drittland (nicht steuerbar)'], ['export', 'Ausfuhrlieferung Drittland'],
  ];

  function table(headers, rows, onRow) {
    return h('div', { class: 'overflow-x-auto rounded-lg border border-gray-200 bg-white' },
      h('table', { class: 'min-w-full divide-y divide-gray-200 text-sm' },
        h('thead', { class: 'bg-gray-50' }, h('tr', {}, headers.map((x) => h('th', { class: `px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 ${x.right ? 'text-right' : ''}` }, x.label || x)))),
        h('tbody', { class: 'divide-y divide-gray-100' },
          rows.length ? rows.map((r) => {
            const tr = h('tr', { class: onRow ? 'cursor-pointer hover:bg-blue-50' : '' }, r.cells.map((c, i) => h('td', { class: `px-3 py-2 ${headers[i] && headers[i].right ? 'whitespace-nowrap text-right tabular-nums' : ''}` }, c)));
            if (onRow) tr.addEventListener('click', () => onRow(r));
            return tr;
          }) : h('tr', {}, h('td', { class: 'px-3 py-6 text-center text-gray-400', colspan: headers.length }, 'Keine Einträge')))));
  }

  function modal(titleText, body, actions) {
    const wrap = h('div', { class: 'fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4' });
    const close = () => wrap.remove();
    const box = h('div', { class: 'mt-12 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl' },
      h('div', { class: 'mb-4 flex items-center justify-between' }, h('h3', { class: 'text-base font-semibold' }, titleText), btn('✕', close, 'link')),
      body, h('div', { class: 'mt-5 flex justify-end gap-2' }, ...(actions ? actions(close) : [btn('Schließen', close)])));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    return close;
  }

  function download(path) {
    window.open(API + path, '_blank', 'noopener');
  }

  function pickFile(accept, cb) {
    const f = h('input', { type: 'file', accept, class: 'hidden' });
    f.addEventListener('change', () => { if (f.files && f.files[0]) cb(f.files[0]); });
    document.body.appendChild(f);
    f.click();
    setTimeout(() => f.remove(), 60000);
  }

  let META = null;
  async function meta() {
    if (!META) META = await api('GET', '/meta');
    return META;
  }
  const unitName = (code) => ((META && META.units.find((u) => u.code === code)) || { de: code }).de;

  /* ------------------------------------------------------------------ layout */

  const NAV = [
    ['', 'Übersicht'], ['invoices', 'Rechnungen'], ['quotes', 'Angebote'], ['contacts', 'Kontakte'],
    ['articles', 'Artikel'], ['expenses', 'Ausgaben'], ['bank', 'Bank'], ['recurring', 'Wiederkehrend'],
    ['reports', 'Auswertungen'], ['export', 'Export'], ['settings', 'Einstellungen'],
  ];
  const nav = h('nav', { class: 'mb-5 flex flex-wrap gap-1 border-b border-gray-200 pb-2' });
  const main = h('div', {});
  root.replaceChildren(nav, main);

  function renderNav(active) {
    nav.replaceChildren(...NAV.map(([k, l]) => h('a', {
      href: `#/${k}`,
      class: `rounded-md px-3 py-1.5 text-sm font-medium ${active === k ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`,
    }, l)));
  }

  async function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [path, query] = hash.split('?');
    const parts = path.split('/').filter(Boolean);
    const params = new URLSearchParams(query || '');
    const section = parts[0] || '';
    renderNav(['doc'].includes(section) ? (params.get('type') === 'quote' ? 'quotes' : 'invoices') : section === 'contact' ? 'contacts' : section === 'expense' ? 'expenses' : section);
    main.replaceChildren(h('p', { class: 'text-sm text-gray-400' }, 'Lädt…'));
    try {
      await meta();
      const view = {
        '': dashboard, invoices: () => docList('invoice'), quotes: () => docList('quote'), credit_notes: () => docList('credit_note'),
        doc: () => docEditor(parts[1], params), contacts: contactList, contact: () => contactEditor(parts[1]),
        articles: articleList, expenses: expenseList, expense: () => expenseEditor(parts[1]), bank: bankView,
        recurring: recurringList, rec: () => recurringEditor(parts[1]), reports: reportsView, export: exportView, settings: settingsView,
      }[section] || dashboard;
      const node = await view();
      main.replaceChildren(node);
    } catch (e) {
      main.replaceChildren(h('div', { class: 'rounded-md bg-red-50 p-4 text-sm text-red-800' }, e.message || String(e)));
    }
  }
  window.addEventListener('hashchange', route);
  const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

  /* ------------------------------------------------------------------ dashboard */

  async function dashboard() {
    const s = await api('GET', '/summary');
    const kpi = (label, value, sub, warn) => card(
      h('div', { class: 'text-xs font-medium uppercase tracking-wide text-gray-500' }, label),
      h('div', { class: `mt-1 text-2xl font-semibold tabular-nums ${warn ? 'text-red-600' : 'text-gray-900'}` }, value),
      sub ? h('div', { class: 'mt-1 text-xs text-gray-500' }, sub) : null);
    const todos = [];
    if (!s.company_ready) todos.push(['Firmendaten vervollständigen (Pflichtangaben für Rechnungen)', '#/settings']);
    if (s.drafts) todos.push([`${s.drafts} Entwürfe abschließen`, '#/invoices?status=draft']);
    if (s.overdue_count) todos.push([`${s.overdue_count} überfällige Rechnungen (${money(s.overdue_cents)})`, '#/invoices?status=overdue']);
    if (s.dunning_due) todos.push([`${s.dunning_due} Mahnungen fällig`, '#/invoices?status=overdue']);
    if (s.unmatched_bank) todos.push([`${s.unmatched_bank} Bankumsätze zuordnen`, '#/bank']);

    const months = [];
    const y = today().slice(0, 4);
    for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
    const max = Math.max(1, ...months.map((m) => s.revenue_by_month[m] || 0));
    const chart = h('div', { class: 'flex h-40 items-end gap-1' }, months.map((m) => {
      const v = s.revenue_by_month[m] || 0;
      const bar = h('div', { class: 'w-full rounded-t bg-blue-500', title: `${m}: ${money(v)}` });
      bar.style.height = `${Math.max(2, (Math.max(0, v) / max) * 100)}%`;
      return h('div', { class: 'flex h-full flex-1 flex-col items-center justify-end gap-1' }, bar, h('span', { class: 'text-[10px] text-gray-400' }, m.slice(5)));
    }));

    return h('div', { class: 'space-y-5' },
      title('Übersicht', btn('+ Rechnung', () => go('#/doc/new?type=invoice'), 'primary'), btn('+ Angebot', () => go('#/doc/new?type=quote')), btn('+ Ausgabe', () => go('#/expense/new'))),
      h('div', { class: 'grid grid-cols-2 gap-3 lg:grid-cols-4' },
        kpi('Umsatz Monat (netto)', money(s.revenue_month_cents)),
        kpi(`Umsatz ${y} (netto)`, money(s.revenue_year_cents), `Ergebnis: ${money(s.result_year_cents)}`),
        kpi('Offene Forderungen', money(s.receivables_cents), s.overdue_cents ? `davon überfällig ${money(s.overdue_cents)}` : 'nichts überfällig', s.overdue_cents > 0),
        kpi('USt-Zahllast Quartal', money(s.vat_quarter.payable_cents), `seit ${date(s.vat_quarter.from)} · Verbindl. ${money(s.payables_cents)}`)),
      h('div', { class: 'grid gap-4 lg:grid-cols-3' },
        h('div', { class: 'lg:col-span-2' }, card(h('div', { class: 'mb-2 text-sm font-semibold' }, `Umsatz ${y} nach Monat`), chart)),
        card(h('div', { class: 'mb-2 text-sm font-semibold' }, 'Zu erledigen'),
          todos.length ? h('ul', { class: 'space-y-2 text-sm' }, todos.map(([t, href]) => h('li', {}, h('a', { href, class: 'text-blue-700 hover:underline' }, `→ ${t}`))))
            : h('p', { class: 'text-sm text-green-700' }, 'Alles erledigt. 🎉'))),
      h('div', { class: 'grid gap-4 lg:grid-cols-3' },
        h('div', { class: 'lg:col-span-2' }, h('div', { class: 'mb-2 text-sm font-semibold' }, 'Zuletzt'),
          table(['Nr.', 'Typ', 'Kunde', 'Datum', { label: 'Betrag', right: true }, 'Status'],
            s.recent.map((d) => ({ d, cells: [d.number || '—', TYPE[d.type], d.recipient.name, date(d.issue_date), money(d.gross_cents, d.currency), badge(d.status)] })),
            (r) => go(`#/doc/${r.d.id}`))),
        card(h('div', { class: 'mb-2 text-sm font-semibold' }, 'Top-Kunden ' + y),
          h('ul', { class: 'space-y-1 text-sm' }, s.top_customers.map((c) => h('li', { class: 'flex justify-between gap-2' }, h('span', { class: 'truncate' }, c.name), h('span', { class: 'tabular-nums text-gray-600' }, money(c.net_cents))))))));
  }

  /* ------------------------------------------------------------------ documents */

  async function docList(type) {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const state = { status: params.get('status') || '', q: '' };
    const list = h('div', {});
    const load = async () => {
      const qs = new URLSearchParams({ type });
      if (state.status) qs.set('status', state.status);
      if (state.q) qs.set('q', state.q);
      const docs = await api('GET', `/documents?${qs}`);
      const total = docs.filter((d) => d.status !== 'draft' && d.status !== 'cancelled').reduce((s, d) => s + d.gross_cents, 0);
      list.replaceChildren(
        table(['Nr.', 'Kunde', 'Datum', type === 'quote' ? 'Gültig' : 'Fällig', { label: 'Brutto', right: true }, { label: 'Offen', right: true }, 'Status'],
          docs.map((d) => ({ d, cells: [d.number || 'Entwurf', d.recipient.name, date(d.issue_date), date(d.due_date), money(d.gross_cents, d.currency),
            type === 'quote' ? '' : money(d.gross_cents - d.paid_cents, d.currency),
            h('span', { class: 'flex gap-1' }, badge(d.overdue ? 'overdue' : d.status), d.dunning_level ? h('span', { class: 'text-xs text-red-600' }, `M${d.dunning_level}`) : null)] })),
          (r) => go(`#/doc/${r.d.id}`)),
        h('p', { class: 'mt-2 text-right text-xs text-gray-500' }, `${docs.length} Dokumente · Summe ${money(total)}`));
    };
    const chips = [['', 'Alle'], ['draft', 'Entwürfe'], ['open', 'Offen'], ['overdue', 'Überfällig'], ['paid', 'Bezahlt'], ['cancelled', 'Storniert']]
      .filter(([k]) => type !== 'quote' || !['overdue', 'paid'].includes(k));
    if (type === 'quote') chips.push(['accepted', 'Angenommen'], ['rejected', 'Abgelehnt'], ['invoiced', 'Abgerechnet']);
    const chipRow = h('div', { class: 'flex flex-wrap gap-1' });
    const renderChips = () => chipRow.replaceChildren(...chips.map(([k, l]) => h('button', {
      type: 'button', class: `rounded-full px-3 py-1 text-xs font-medium ${state.status === k ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50'}`,
      onclick: () => { state.status = k; renderChips(); load(); },
    }, l)));
    renderChips();
    let timer;
    const search = input({ placeholder: 'Suchen (Nr., Kunde)…', oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value; load(); }, 250); } });
    await load();
    const tabs = h('div', { class: 'mb-3 flex gap-3 text-sm' },
      [['invoice', 'Rechnungen', '#/invoices'], ['credit_note', 'Gutschriften', '#/credit_notes'], ['quote', 'Angebote', '#/quotes']]
        .map(([t, l, href]) => h('a', { href, class: t === type ? 'font-semibold text-blue-700' : 'text-gray-500 hover:text-gray-800' }, l)));
    return h('div', {},
      title(type === 'quote' ? 'Angebote' : type === 'credit_note' ? 'Gutschriften' : 'Rechnungen',
        type !== 'credit_note' ? btn(`+ ${TYPE[type]}`, () => go(`#/doc/new?type=${type}`), 'primary') : null),
      tabs, h('div', { class: 'mb-3 flex flex-wrap items-center justify-between gap-2' }, chipRow, h('div', { class: 'w-64' }, search)), list);
  }

  /** Client-side mirror of computeTotals, for the live preview only. The server recomputes. */
  function previewTotals(lines, treatment, priceMode) {
    const zero = treatment !== 'domestic';
    const groups = {};
    let net = 0;
    for (const l of lines) {
      if (l.type === 'text') continue;
      const rate = zero ? 0 : Number(l.tax_rate) || 0;
      const raw = (Number(l.quantity) || 0) * (l.unit_price_cents || 0) * (1 - (Number(l.discount_percent) || 0) / 100);
      let n = Math.round(raw);
      if (priceMode === 'gross') n = Math.round((n * 100) / (100 + rate));
      groups[rate] = (groups[rate] || 0) + n;
      net += n;
    }
    let tax = 0;
    const g = Object.entries(groups).map(([r, n]) => { const t = Math.round((n * Number(r)) / 100); tax += t; return [Number(r), n, t]; });
    return { net, tax, gross: net + tax, groups: g.sort((a, b) => b[0] - a[0]) };
  }

  async function docEditor(id, params) {
    const [contacts, articles, company, settings] = await Promise.all([api('GET', '/contacts'), api('GET', '/articles'), api('GET', '/company'), api('GET', '/settings')]);
    let doc;
    if (id === 'new') {
      const type = params.get('type') || 'invoice';
      const t = settings.texts;
      doc = {
        type, status: 'draft', lines: [{ type: 'item', name: '', quantity: 1, unit: 'HUR', unit_price_cents: 0, tax_rate: 19 }],
        tax_treatment: '', price_mode: 'net', currency: company.default_currency || 'EUR', recipient: {}, einvoice_format: 'zugferd', issue_date: '', service_date: '',
        intro: type === 'quote' ? t.quote_intro : t.invoice_intro, closing: type === 'quote' ? t.quote_closing : t.invoice_closing,
        contact_id: params.get('contact') || undefined,
      };
    } else {
      doc = await api('GET', `/documents/${id}`);
    }
    const editable = doc.status === 'draft';
    const box = h('div', { class: 'space-y-4' });

    if (!editable) return finalizedView(doc, box);

    const contactSel = select({}, [['', '— Kontakt wählen —'], ...contacts.filter((c) => c.roles.customer).map((c) => [c.id, `${c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ')}${c.customer_number ? ` (${c.customer_number})` : ''}`])], doc.contact_id);
    const f = {
      title: input({ value: doc.title || '', placeholder: TYPE[doc.type] }),
      issue_date: input({ type: 'date', value: doc.issue_date || '' }),
      service_date: input({ type: 'date', value: doc.service_date || '' }),
      service_date_end: input({ type: 'date', value: doc.service_date_end || '' }),
      valid_until: input({ type: 'date', value: doc.valid_until || '' }),
      payment_days: input({ type: 'number', min: 0, value: doc.payment_days ?? company.default_payment_days }),
      tax_treatment: select({}, [['', 'Automatisch (aus Kunde)'], ...TREATMENTS], doc.tax_treatment),
      price_mode: select({}, [['net', 'Netto-Preise'], ['gross', 'Brutto-Preise']], doc.price_mode),
      einvoice_format: select({}, [['zugferd', 'ZUGFeRD (PDF + XML)'], ['xrechnung', 'XRechnung (XML)'], ['pdf', 'Nur PDF']], doc.einvoice_format),
      intro: textarea({ value: doc.intro || '' }),
      closing: textarea({ value: doc.closing || '' }),
      internal_note: textarea({ value: doc.internal_note || '', rows: 2 }),
    };
    let lines = (doc.lines || []).map((l) => ({ ...l }));
    const linesBox = h('div', {});
    const totalsBox = h('div', { class: 'ml-auto w-72 space-y-1 text-sm' });

    function renderTotals() {
      const t = previewTotals(lines, f.tax_treatment.value || 'domestic', f.price_mode.value);
      totalsBox.replaceChildren(
        h('div', { class: 'flex justify-between' }, h('span', {}, 'Netto'), h('span', { class: 'tabular-nums' }, money(t.net))),
        ...t.groups.filter((g) => g[0] > 0).map((g) => h('div', { class: 'flex justify-between text-gray-600' }, h('span', {}, `USt. ${g[0]} %`), h('span', { class: 'tabular-nums' }, money(g[2])))),
        h('div', { class: 'flex justify-between border-t border-gray-300 pt-1 font-semibold' }, h('span', {}, 'Gesamt'), h('span', { class: 'tabular-nums' }, money(t.gross))));
    }

    function renderLines() {
      linesBox.replaceChildren(
        h('div', { class: 'grid grid-cols-12 gap-2 px-1 text-xs font-medium text-gray-500' },
          h('div', { class: 'col-span-5' }, 'Bezeichnung / Beschreibung'), h('div', { class: 'col-span-1' }, 'Menge'), h('div', { class: 'col-span-2' }, 'Einheit'),
          h('div', { class: 'col-span-2' }, `Preis (${f.price_mode.value === 'gross' ? 'brutto' : 'netto'})`), h('div', { class: 'col-span-1' }, 'USt %'), h('div', { class: 'col-span-1' }, '')),
        ...lines.map((l, i) => {
          const upd = (k, v) => { l[k] = v; renderTotals(); };
          if (l.type === 'text') {
            return h('div', { class: 'grid grid-cols-12 items-start gap-2 rounded-md bg-gray-50 p-1' },
              h('div', { class: 'col-span-11' }, input({ value: l.name, placeholder: 'Zwischenüberschrift / Text', oninput: (e) => upd('name', e.target.value) })),
              h('div', { class: 'col-span-1 text-right' }, btn('✕', () => { lines.splice(i, 1); renderLines(); renderTotals(); }, 'link')));
          }
          return h('div', { class: 'grid grid-cols-12 items-start gap-2 rounded-md p-1 hover:bg-gray-50' },
            h('div', { class: 'col-span-5 space-y-1' },
              input({ value: l.name, placeholder: 'Leistung', oninput: (e) => upd('name', e.target.value) }),
              textarea({ value: l.description || '', rows: 1, placeholder: 'Beschreibung (optional)', oninput: (e) => upd('description', e.target.value) }),
              h('div', { class: 'flex gap-1' },
                input({ type: 'date', value: l.period_start || '', title: 'Zeitraum von', oninput: (e) => upd('period_start', e.target.value || undefined) }),
                input({ type: 'date', value: l.period_end || '', title: 'Zeitraum bis', oninput: (e) => upd('period_end', e.target.value || undefined) }))),
            h('div', { class: 'col-span-1' }, input({ value: String(l.quantity).replace('.', ','), oninput: (e) => upd('quantity', Number(e.target.value.replace(',', '.')) || 0) })),
            h('div', { class: 'col-span-2' }, select({ onchange: (e) => upd('unit', e.target.value) }, META.units.map((u) => [u.code, u.de]), l.unit)),
            h('div', { class: 'col-span-2 space-y-1' },
              input({ value: centsInput(l.unit_price_cents), oninput: (e) => upd('unit_price_cents', parseMoney(e.target.value)) }),
              input({ value: l.discount_percent || '', placeholder: 'Rabatt %', oninput: (e) => upd('discount_percent', Number(e.target.value.replace(',', '.')) || undefined) })),
            h('div', { class: 'col-span-1' }, select({ onchange: (e) => upd('tax_rate', Number(e.target.value)) }, [[19, '19'], [7, '7'], [0, '0']], l.tax_rate)),
            h('div', { class: 'col-span-1 text-right' }, btn('✕', () => { lines.splice(i, 1); renderLines(); renderTotals(); }, 'link')));
        }),
        h('div', { class: 'flex flex-wrap gap-2 pt-2' },
          btn('+ Position', () => { lines.push({ type: 'item', name: '', quantity: 1, unit: 'HUR', unit_price_cents: 0, tax_rate: 19 }); renderLines(); }),
          articles.length ? select({ onchange: (e) => {
            const a = articles.find((x) => x.id === e.target.value);
            if (a) { lines.push({ type: 'item', article_id: a.id, name: a.title, description: a.description, quantity: 1, unit: a.unit, unit_price_cents: a.unit_price_cents, tax_rate: a.tax_rate }); renderLines(); renderTotals(); }
            e.target.value = '';
          } }, [['', '+ Artikel einfügen…'], ...articles.map((a) => [a.id, `${a.title} — ${money(a.unit_price_cents)}`])], '') : null,
          btn('+ Text', () => { lines.push({ type: 'text', name: '', quantity: 0, unit: 'C62', unit_price_cents: 0, tax_rate: 19 }); renderLines(); })));
    }
    f.price_mode.addEventListener('change', () => { renderLines(); renderTotals(); });
    f.tax_treatment.addEventListener('change', renderTotals);
    renderLines();
    renderTotals();

    const collect = () => ({
      type: doc.type, contact_id: contactSel.value || undefined, title: f.title.value, issue_date: f.issue_date.value || undefined,
      service_date: f.service_date.value || undefined, service_date_end: f.service_date_end.value || undefined,
      valid_until: f.valid_until.value || undefined, payment_days: Number(f.payment_days.value) || 0,
      tax_treatment: f.tax_treatment.value || undefined, price_mode: f.price_mode.value, einvoice_format: f.einvoice_format.value,
      intro: f.intro.value, closing: f.closing.value, internal_note: f.internal_note.value, lines,
    });
    const save = async () => {
      const body = collect();
      if (!body.contact_id && !doc.id) throw new Error('Bitte einen Kontakt wählen.');
      const saved = doc.id ? await api('PUT', `/documents/${doc.id}`, body) : await api('POST', '/documents', body);
      doc = saved;
      if (location.hash !== `#/doc/${saved.id}`) history.replaceState(null, '', `#/doc/${saved.id}`);
      return saved;
    };
    const checks = h('div', {});
    const showCheck = (c) => checks.replaceChildren(
      ...c.errors.map((m) => h('div', { class: 'rounded-md bg-red-50 px-3 py-2 text-sm text-red-800' }, `✗ ${m}`)),
      ...c.warnings.map((m) => h('div', { class: 'rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800' }, `! ${m}`)));

    append(box, 
      title(`${TYPE[doc.type]} — Entwurf`,
        btn('Speichern', () => run(save, 'Gespeichert')),
        btn('Vorschau PDF', () => run(async () => { const d = await save(); download(`/documents/${d.id}/pdf?inline=1`); })),
        btn('Prüfen', () => run(async () => { const d = await save(); showCheck(await api('GET', `/documents/${d.id}/check`)); })),
        btn(doc.type === 'quote' ? 'Abschließen' : 'Abschließen & Nummer vergeben', () => run(async () => {
          const d = await save();
          const c = await api('GET', `/documents/${d.id}/check`);
          showCheck(c);
          if (c.errors.length) return;
          if (!confirmBox(`${TYPE[d.type]} abschließen? Danach ist sie nicht mehr änderbar (GoBD) — Korrekturen nur per Gutschrift.`)) return;
          await api('POST', `/documents/${d.id}/finalize`);
          toast('Abgeschlossen');
          go(`#/doc/${d.id}`);
        }), 'primary'),
        doc.id ? btn('Löschen', () => run(async () => {
          if (!confirmBox('Entwurf löschen?')) return;
          await api('DELETE', `/documents/${doc.id}`);
          go(doc.type === 'quote' ? '#/quotes' : '#/invoices');
        }), 'danger') : null),
      checks,
      h('div', { class: 'grid gap-4 lg:grid-cols-3' },
        card(h('div', { class: 'space-y-3' },
          field('Kunde', contactSel, h('a', { href: '#/contact/new', class: 'text-blue-600' }, '+ neuer Kontakt')),
          doc.recipient && doc.recipient.name ? h('div', { class: 'rounded bg-gray-50 p-2 text-xs text-gray-600' }, [doc.recipient.name, doc.recipient.street, `${doc.recipient.zip || ''} ${doc.recipient.city || ''}`, doc.recipient.country].filter(Boolean).join(' · ')) : null,
          field('Steuerfall', f.tax_treatment), field('E-Rechnungs-Format', f.einvoice_format, 'ZUGFeRD ist für die meisten Kunden ideal; XRechnung für Behörden (Leitweg-ID am Kontakt).'))),
        card(h('div', { class: 'grid grid-cols-2 gap-3' },
          field('Titel', f.title), field('Preise', f.price_mode),
          field('Rechnungsdatum', f.issue_date, 'leer = Tag des Abschlusses'), field(doc.type === 'quote' ? 'Gültig bis' : 'Zahlungsziel (Tage)', doc.type === 'quote' ? f.valid_until : f.payment_days),
          field('Leistungsdatum / von', f.service_date), field('Leistung bis', f.service_date_end))),
        card(h('div', { class: 'space-y-3' }, field('Einleitung', f.intro), field('Schlusstext', f.closing), field('Interne Notiz (nicht gedruckt)', f.internal_note)))),
      card(linesBox, h('div', { class: 'mt-4 flex' }, totalsBox)));
    return box;
  }

  function confirmBox(msg) {
    // A native confirm is the one dialog guaranteed to be read before a
    // one-way action (finalize, cancel). Used sparingly.
    return window.confirm(msg);
  }

  function finalizedView(doc, box) {
    const open = doc.totals.gross_cents - doc.paid_cents;
    const actions = [
      btn('PDF', () => download(`/documents/${doc.id}/pdf?inline=1`)),
      doc.einvoice_format !== 'pdf' && doc.type !== 'quote' ? btn('XML', () => download(`/documents/${doc.id}/xml`)) : null,
      btn('Per E-Mail senden', () => sendDialog(doc), 'primary'),
      btn('Duplizieren', () => run(async () => { const d = await api('POST', `/documents/${doc.id}/duplicate`); go(`#/doc/${d.id}`); })),
    ];
    if (doc.type === 'invoice' && ['open', 'partially_paid'].includes(doc.status)) {
      actions.push(btn('Zahlung erfassen', () => paymentDialog(doc)));
      actions.push(btn('Mahnen', () => run(async () => {
        const r = await api('POST', `/documents/${doc.id}/dunning`, { send: confirmBox('Mahnung direkt per E-Mail senden? (Abbrechen = nur PDF erzeugen)') });
        download(`/files/${r.pdf_id}`);
        route();
      })));
    }
    if (doc.type === 'invoice' && doc.status !== 'cancelled') {
      actions.push(btn('Stornieren', () => run(async () => {
        const reason = window.prompt('Grund der Stornierung (erscheint auf der Gutschrift, optional):', '');
        if (reason === null) return;
        const r = await api('POST', `/documents/${doc.id}/cancel`, { reason });
        toast(`Storniert durch ${r.credit_note.number}`);
        go(`#/doc/${r.credit_note.id}`);
      }), 'danger'));
    }
    if (doc.type === 'quote' && doc.status === 'open') {
      actions.push(btn('Angenommen', () => run(async () => { await api('POST', `/documents/${doc.id}/quote-status`, { status: 'accepted' }); route(); })));
      actions.push(btn('Abgelehnt', () => run(async () => { await api('POST', `/documents/${doc.id}/quote-status`, { status: 'rejected' }); route(); })));
    }
    if (doc.type === 'quote' && ['open', 'accepted'].includes(doc.status)) {
      actions.push(btn('→ Rechnung erstellen', () => run(async () => { const d = await api('POST', `/documents/${doc.id}/to-invoice`); go(`#/doc/${d.id}`); }), 'primary'));
    }
    const r = doc.recipient;
    const tot = doc.totals;
    append(box, 
      title(`${TYPE[doc.type]} ${doc.number}`, ...actions),
      h('div', { class: 'grid gap-4 lg:grid-cols-3' },
        card(h('div', { class: 'space-y-1 text-sm' },
          h('div', { class: 'flex items-center gap-2' }, badge(doc.status), doc.dunning_level ? h('span', { class: 'text-xs text-red-600' }, `Mahnstufe ${doc.dunning_level}`) : null, doc.imported ? h('span', { class: 'text-xs text-gray-500' }, 'importiert') : null),
          h('div', { class: 'pt-2 font-medium' }, r.name), h('div', {}, r.street), h('div', {}, `${r.zip || ''} ${r.city || ''}`), h('div', { class: 'text-gray-500' }, r.email || ''),
          r.vat_id ? h('div', { class: 'text-gray-500' }, `USt-IdNr. ${r.vat_id}`) : null)),
        card(h('dl', { class: 'grid grid-cols-2 gap-1 text-sm' },
          h('dt', { class: 'text-gray-500' }, 'Datum'), h('dd', {}, date(doc.issue_date)),
          h('dt', { class: 'text-gray-500' }, doc.type === 'quote' ? 'Gültig bis' : 'Fällig'), h('dd', {}, date(doc.type === 'quote' ? doc.valid_until : doc.due_date)),
          h('dt', { class: 'text-gray-500' }, 'Leistung'), h('dd', {}, doc.service_date_end ? `${date(doc.service_date)} – ${date(doc.service_date_end)}` : date(doc.service_date)),
          h('dt', { class: 'text-gray-500' }, 'Format'), h('dd', {}, doc.einvoice_format),
          h('dt', { class: 'text-gray-500' }, 'Versendet'), h('dd', {}, doc.sent_at ? date(doc.sent_at) : '—'),
          doc.refers_to_number ? h('dt', { class: 'text-gray-500' }, 'Bezieht sich auf') : null, doc.refers_to_number ? h('dd', {}, h('a', { href: `#/doc/${doc.refers_to_id}`, class: 'text-blue-600' }, doc.refers_to_number)) : null,
          doc.cancelled_by_id ? h('dt', { class: 'text-gray-500' }, 'Storniert durch') : null, doc.cancelled_by_id ? h('dd', {}, h('a', { href: `#/doc/${doc.cancelled_by_id}`, class: 'text-blue-600' }, 'Gutschrift')) : null)),
        card(h('div', { class: 'space-y-1 text-sm' },
          h('div', { class: 'flex justify-between' }, h('span', {}, 'Netto'), h('span', { class: 'tabular-nums' }, money(tot.net_cents, doc.currency))),
          ...tot.groups.filter((g) => g.rate > 0).map((g) => h('div', { class: 'flex justify-between text-gray-600' }, h('span', {}, `USt. ${g.rate} %`), h('span', { class: 'tabular-nums' }, money(g.tax_cents, doc.currency)))),
          h('div', { class: 'flex justify-between border-t pt-1 font-semibold' }, h('span', {}, 'Brutto'), h('span', { class: 'tabular-nums' }, money(tot.gross_cents, doc.currency))),
          doc.type !== 'quote' ? h('div', { class: 'flex justify-between text-gray-600' }, h('span', {}, 'Bezahlt'), h('span', { class: 'tabular-nums' }, money(doc.paid_cents, doc.currency))) : null,
          doc.type !== 'quote' ? h('div', { class: `flex justify-between font-medium ${open > 0 ? 'text-red-700' : 'text-green-700'}` }, h('span', {}, 'Offen'), h('span', { class: 'tabular-nums' }, money(open, doc.currency))) : null))),
      table(['Pos.', 'Bezeichnung', { label: 'Menge', right: true }, 'Einheit', { label: 'Einzelpreis', right: true }],
        doc.lines.filter((l) => l.type === 'item').map((l, i) => ({ cells: [String(i + 1), h('div', {}, l.name, l.description ? h('div', { class: 'text-xs text-gray-500' }, l.description) : null), String(l.quantity).replace('.', ','), unitName(l.unit), money(l.unit_price_cents, doc.currency)] }))),
      doc.payments && doc.payments.length ? h('div', {}, h('h3', { class: 'mb-2 mt-4 text-sm font-semibold' }, 'Zahlungen'),
        table(['Datum', 'Art', 'Referenz', { label: 'Betrag', right: true }, ''], doc.payments.map((p) => ({
          cells: [date(p.date), p.method, p.reference || p.note || '', money(p.amount_cents, doc.currency),
            p.method === 'offset' ? '' : btn('entfernen', (e) => { e.stopPropagation(); run(async () => { if (!confirmBox('Zahlung entfernen?')) return; await api('DELETE', `/payments/${p.id}`); route(); }); }, 'link')],
        })))) : null,
      doc.public_url ? h('p', { class: 'text-xs text-gray-500' }, 'Kunden-Link: ', h('a', { href: doc.public_url, class: 'text-blue-600 break-all', target: '_blank', rel: 'noopener' }, doc.public_url)) : null,
      doc.content_hash ? h('p', { class: 'text-xs text-gray-400' }, `GoBD-Prüfsumme: ${doc.content_hash.slice(0, 16)}…  · abgeschlossen ${date(doc.finalized_at)}`) : null);
    return box;
  }

  function sendDialog(doc) {
    const to = input({ value: doc.recipient.email || '', type: 'email' });
    const subject = input({ placeholder: '(Standard-Betreff aus den Einstellungen)' });
    const message = textarea({ rows: 6, placeholder: '(Standardtext aus den Einstellungen)' });
    modal(`${TYPE[doc.type]} ${doc.number} senden`, h('div', { class: 'space-y-3' }, field('An', to), field('Betreff', subject), field('Nachricht', message),
      h('p', { class: 'text-xs text-gray-500' }, doc.einvoice_format === 'xrechnung' ? 'Anhänge: PDF und XRechnung-XML.' : 'Anhang: PDF (bei ZUGFeRD mit eingebetteter E-Rechnung).')),
    (close) => [btn('Abbrechen', close), btn('Senden', () => run(async () => {
      await api('POST', `/documents/${doc.id}/send`, { to: to.value, subject: subject.value || undefined, message: message.value || undefined });
      close();
      route();
    }, 'Gesendet'), 'primary')]);
  }

  function paymentDialog(doc) {
    const amount = input({ value: centsInput(doc.totals.gross_cents - doc.paid_cents) });
    const d = input({ type: 'date', value: today() });
    const method = select({}, [['bank', 'Überweisung'], ['cash', 'Bar'], ['stripe', 'Stripe'], ['paypal', 'PayPal'], ['card', 'Karte'], ['other', 'Sonstige']], 'bank');
    const ref = input({});
    modal('Zahlung erfassen', h('div', { class: 'grid grid-cols-2 gap-3' }, field('Betrag', amount), field('Datum', d), field('Art', method), field('Referenz', ref)),
      (close) => [btn('Abbrechen', close), btn('Speichern', () => run(async () => {
        await api('POST', `/documents/${doc.id}/payments`, { amount_cents: parseMoney(amount.value), date: d.value, method: method.value, reference: ref.value });
        close();
        route();
      }, 'Zahlung gespeichert'), 'primary')]);
  }

  /* ------------------------------------------------------------------ contacts */

  async function contactList() {
    const all = await api('GET', '/contacts');
    const list = h('div', {});
    const draw = (q) => list.replaceChildren(table(['Nr.', 'Name', 'E-Mail', 'Ort', 'USt-IdNr.', 'Rolle'],
      all.filter((c) => !q || JSON.stringify(c).toLowerCase().includes(q.toLowerCase())).map((c) => ({
        c, cells: [c.customer_number || c.vendor_number || '', c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' '), c.email || '',
          [c.billing_address.zip, c.billing_address.city, c.billing_address.country !== 'DE' ? c.billing_address.country : ''].filter(Boolean).join(' '), c.vat_id || '',
          [c.roles.customer ? 'Kunde' : '', c.roles.vendor ? 'Lieferant' : ''].filter(Boolean).join(', ')],
      })), (r) => go(`#/contact/${r.c.id}`)));
    draw('');
    return h('div', {},
      title('Kontakte', btn('CSV importieren', () => pickFile('.csv,text/csv', (f) => run(async () => {
        const r = await api('POST', '/upload/contacts', await f.text());
        toast(`${r.created} importiert, ${r.skipped} übersprungen${r.errors.length ? `, ${r.errors.length} Fehler` : ''}`);
        route();
      }))), btn('+ Kontakt', () => go('#/contact/new'), 'primary')),
      h('div', { class: 'mb-3 w-72' }, input({ placeholder: 'Suchen…', oninput: (e) => draw(e.target.value) })), list);
  }

  async function contactEditor(id) {
    const c = id === 'new' ? { kind: 'company', roles: { customer: true, vendor: false }, billing_address: { country: 'DE' } } : await api('GET', `/contacts/${id}`);
    const a = c.billing_address || {};
    const f = {
      kind: select({}, [['company', 'Firma'], ['person', 'Privatperson']], c.kind),
      company_name: input({ value: c.company_name || '' }), salutation: input({ value: c.salutation || '' }),
      first_name: input({ value: c.first_name || '' }), last_name: input({ value: c.last_name || '' }),
      email: input({ value: c.email || '', type: 'email' }), invoice_email: input({ value: c.invoice_email || '', type: 'email' }),
      phone: input({ value: c.phone || '' }), street: input({ value: a.street || '' }), supplement: input({ value: a.supplement || '' }),
      zip: input({ value: a.zip || '' }), city: input({ value: a.city || '' }), country: input({ value: a.country || 'DE', maxlength: 2 }),
      vat_id: input({ value: c.vat_id || '' }), tax_number: input({ value: c.tax_number || '' }),
      buyer_reference: input({ value: c.buyer_reference || '' }),
      einvoice_format: select({}, [['', 'Standard'], ['zugferd', 'ZUGFeRD'], ['xrechnung', 'XRechnung'], ['pdf', 'Nur PDF']], c.einvoice_format),
      payment_days: input({ type: 'number', value: c.payment_days ?? '' }), datev_account: input({ type: 'number', value: c.datev_account ?? '' }),
      customer: h('input', { type: 'checkbox', checked: c.roles.customer }), vendor: h('input', { type: 'checkbox', checked: c.roles.vendor }),
      notes: textarea({ value: c.notes || '' }),
    };
    const save = () => run(async () => {
      const body = {
        kind: f.kind.value, company_name: f.company_name.value, salutation: f.salutation.value, first_name: f.first_name.value, last_name: f.last_name.value,
        email: f.email.value, invoice_email: f.invoice_email.value, phone: f.phone.value,
        billing_address: { street: f.street.value, supplement: f.supplement.value, zip: f.zip.value, city: f.city.value, country: f.country.value.toUpperCase() },
        vat_id: f.vat_id.value, tax_number: f.tax_number.value, buyer_reference: f.buyer_reference.value, einvoice_format: f.einvoice_format.value || undefined,
        payment_days: f.payment_days.value === '' ? null : Number(f.payment_days.value), datev_account: f.datev_account.value ? Number(f.datev_account.value) : null,
        roles: { customer: f.customer.checked, vendor: f.vendor.checked }, notes: f.notes.value,
      };
      const saved = id === 'new' ? await api('POST', '/contacts', body) : await api('PUT', `/contacts/${id}`, body);
      toast('Gespeichert');
      go(`#/contact/${saved.id}`);
    });
    return h('div', { class: 'space-y-4' },
      title(id === 'new' ? 'Neuer Kontakt' : (c.company_name || `${c.first_name || ''} ${c.last_name || ''}`),
        id !== 'new' ? btn('+ Rechnung', () => run(async () => { const d = await api('POST', '/documents', { type: 'invoice', contact_id: id, lines: [] }); go(`#/doc/${d.id}`); })) : null,
        btn('Speichern', save, 'primary')),
      h('div', { class: 'grid gap-4 lg:grid-cols-2' },
        card(h('div', { class: 'grid grid-cols-2 gap-3' },
          field('Art', f.kind), h('div', { class: 'flex items-end gap-4 text-sm' }, h('label', { class: 'flex items-center gap-1' }, f.customer, 'Kunde'), h('label', { class: 'flex items-center gap-1' }, f.vendor, 'Lieferant')),
          h('div', { class: 'col-span-2' }, field('Firma', f.company_name)), field('Anrede', f.salutation), h('div', {}),
          field('Vorname', f.first_name), field('Nachname', f.last_name),
          field('E-Mail', f.email), field('Rechnungs-E-Mail', f.invoice_email, 'falls Rechnungen an eine andere Adresse gehen'), field('Telefon', f.phone))),
        card(h('div', { class: 'grid grid-cols-2 gap-3' },
          h('div', { class: 'col-span-2' }, field('Straße', f.street)), h('div', { class: 'col-span-2' }, field('Adresszusatz', f.supplement)),
          field('PLZ', f.zip), field('Ort', f.city), field('Land (ISO)', f.country),
          field('USt-IdNr.', f.vat_id, 'Pflicht für Reverse Charge in der EU'), field('Steuernummer', f.tax_number),
          field('Käuferreferenz / Leitweg-ID', f.buyer_reference, 'Behörden: Leitweg-ID (XRechnung)'), field('E-Rechnungs-Format', f.einvoice_format),
          field('Zahlungsziel (Tage)', f.payment_days), field('DATEV-Personenkonto', f.datev_account),
          h('div', { class: 'col-span-2' }, field('Notizen', f.notes))))),
      c.documents && c.documents.length ? h('div', {}, h('h3', { class: 'mb-2 text-sm font-semibold' }, 'Belege'),
        table(['Nr.', 'Typ', 'Datum', { label: 'Betrag', right: true }, 'Status'], c.documents.map((d) => ({ d, cells: [d.number || 'Entwurf', TYPE[d.type], date(d.issue_date), money(d.gross_cents, d.currency), badge(d.status)] })), (r) => go(`#/doc/${r.d.id}`))) : null);
  }

  /* ------------------------------------------------------------------ articles */

  async function articleList() {
    const arts = await api('GET', '/articles');
    const edit = (a) => {
      const f = {
        title: input({ value: a.title || '' }), number: input({ value: a.number || '' }), description: textarea({ value: a.description || '' }),
        unit: select({}, META.units.map((u) => [u.code, u.de]), a.unit || 'HUR'), price: input({ value: centsInput(a.unit_price_cents || 0) }),
        tax_rate: select({}, [[19, '19 %'], [7, '7 %'], [0, '0 %']], a.tax_rate ?? 19), type: select({}, [['service', 'Leistung'], ['product', 'Produkt']], a.type || 'service'),
      };
      modal(a.id ? 'Artikel bearbeiten' : 'Neuer Artikel', h('div', { class: 'grid grid-cols-2 gap-3' },
        h('div', { class: 'col-span-2' }, field('Bezeichnung', f.title)), field('Artikelnr.', f.number), field('Art', f.type),
        h('div', { class: 'col-span-2' }, field('Beschreibung', f.description)), field('Einheit', f.unit), field('Preis netto', f.price), field('USt', f.tax_rate)),
      (close) => [a.id ? btn('Löschen', () => run(async () => { await api('DELETE', `/articles/${a.id}`); close(); route(); }), 'danger') : null, btn('Abbrechen', close),
        btn('Speichern', () => run(async () => {
          const body = { title: f.title.value, number: f.number.value, description: f.description.value, unit: f.unit.value, unit_price_cents: parseMoney(f.price.value), tax_rate: Number(f.tax_rate.value), type: f.type.value };
          if (a.id) await api('PUT', `/articles/${a.id}`, body); else await api('POST', '/articles', body);
          close();
          route();
        }, 'Gespeichert'), 'primary')]);
    };
    return h('div', {}, title('Artikel & Leistungen', btn('+ Artikel', () => edit({}), 'primary')),
      table(['Nr.', 'Bezeichnung', 'Einheit', { label: 'Preis netto', right: true }, 'USt'], arts.map((a) => ({ a, cells: [a.number || '', a.title, unitName(a.unit), money(a.unit_price_cents), `${a.tax_rate} %`] })), (r) => edit(r.a)));
  }

  /* ------------------------------------------------------------------ expenses */

  async function expenseList() {
    const list = await api('GET', '/expenses');
    const drop = h('div', { class: 'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500 hover:border-blue-400 hover:bg-blue-50' },
      h('div', { class: 'font-medium text-gray-700' }, 'Belege hierher ziehen oder klicken'),
      h('div', {}, 'PDF, Foto oder E-Rechnung (XRechnung / ZUGFeRD wird automatisch ausgelesen)'));
    const upload = async (files) => {
      for (const file of files) {
        await run(async () => {
          const r = await api('POST', `/upload/receipt?filename=${encodeURIComponent(file.name)}`, file, { contentType: file.type || 'application/octet-stream' });
          toast(r.duplicate ? `${file.name}: bereits vorhanden` : r.parsed ? `${file.name}: E-Rechnung von ${r.parsed.seller.name} erkannt` : `${file.name}: hochgeladen — bitte Beträge ergänzen`);
        });
      }
      route();
    };
    drop.addEventListener('click', () => pickFile('.pdf,.xml,image/*', (f) => upload([f])));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('border-blue-400'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('border-blue-400'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); upload([...e.dataTransfer.files]); });
    const cat = (k) => ((META.categories.find((c) => c.key === k) || {}).de || k);
    return h('div', { class: 'space-y-4' },
      title('Ausgaben', btn('+ Ausgabe', () => go('#/expense/new'), 'primary')), drop,
      table(['Datum', 'Lieferant', 'Beleg-Nr.', 'Kategorie', { label: 'Brutto', right: true }, 'Status', ''], list.map((e) => ({
        e, cells: [date(e.date), e.supplier_name, e.invoice_number || '', cat(e.lines[0] && e.lines[0].category), money(e.gross_cents, e.currency),
          badge(e.status === 'open' ? 'open' : e.status), e.file_id || e.xml_file_id ? '📎' : h('span', { class: 'text-xs text-amber-600' }, 'kein Beleg')],
      })), (r) => go(`#/expense/${r.e.id}`)));
  }

  async function expenseEditor(id) {
    const e = id === 'new' ? { status: 'open', date: today(), lines: [{ category: 'software', net_cents: 0, tax_rate: 19, tax_cents: 0 }], currency: 'EUR' } : await api('GET', `/expenses/${id}`);
    const booked = e.status !== 'draft' && id !== 'new';
    const f = {
      supplier_name: input({ value: e.supplier_name || '', disabled: booked }), invoice_number: input({ value: e.invoice_number || '', disabled: booked }),
      date: input({ type: 'date', value: e.date || today(), disabled: booked }), due_date: input({ type: 'date', value: e.due_date || '' }),
      supplier_vat_id: input({ value: e.supplier_vat_id || '', disabled: booked }), supplier_country: input({ value: e.supplier_country || '', maxlength: 2 }),
      reverse_charge: h('input', { type: 'checkbox', checked: e.reverse_charge, disabled: booked }),
      status: select({}, [['draft', 'Entwurf'], ['open', 'Offen (unbezahlt)'], ['paid', 'Bezahlt']], e.status),
      note: textarea({ value: e.note || '' }),
    };
    let lines = e.lines.map((l) => ({ ...l }));
    const linesBox = h('div', { class: 'space-y-2' });
    const sum = h('div', { class: 'text-right text-sm font-semibold' });
    const redraw = () => {
      const g = lines.reduce((s, l) => s + l.net_cents + (f.reverse_charge.checked ? 0 : l.tax_cents), 0);
      sum.textContent = `Brutto ${money(g)}`;
    };
    const drawLines = () => {
      linesBox.replaceChildren(...lines.map((l, i) => {
        const gross = input({ value: centsInput(l.net_cents + l.tax_cents) });
        const rate = select({}, [[19, '19 %'], [7, '7 %'], [0, '0 %']], l.tax_rate);
        const net = input({ value: centsInput(l.net_cents) });
        const sync = (from) => {
          const r = Number(rate.value);
          if (from === 'gross') { const gc = parseMoney(gross.value); l.net_cents = Math.round((gc * 100) / (100 + r)); l.tax_cents = gc - l.net_cents; net.value = centsInput(l.net_cents); }
          else { l.net_cents = parseMoney(net.value); l.tax_cents = Math.round((l.net_cents * r) / 100); gross.value = centsInput(l.net_cents + l.tax_cents); }
          l.tax_rate = r;
          redraw();
        };
        gross.addEventListener('input', () => sync('gross'));
        net.addEventListener('input', () => sync('net'));
        rate.addEventListener('change', () => sync('gross'));
        return h('div', { class: 'grid grid-cols-12 items-end gap-2' },
          h('div', { class: 'col-span-4' }, field('Kategorie', select({ onchange: (ev) => { l.category = ev.target.value; } }, META.categories.map((c) => [c.key, c.de]), l.category))),
          h('div', { class: 'col-span-3' }, field('Beschreibung', input({ value: l.description || '', oninput: (ev) => { l.description = ev.target.value; } }))),
          h('div', { class: 'col-span-2' }, field('Brutto', gross)), h('div', { class: 'col-span-1' }, field('USt', rate)),
          h('div', { class: 'col-span-1' }, field('Netto', net)),
          h('div', { class: 'col-span-1 text-right' }, lines.length > 1 ? btn('✕', () => { lines.splice(i, 1); drawLines(); }, 'link') : null));
      }), btn('+ Zeile', () => { lines.push({ category: 'other', net_cents: 0, tax_rate: 19, tax_cents: 0 }); drawLines(); }));
      redraw();
    };
    f.reverse_charge.addEventListener('change', redraw);
    drawLines();
    const save = () => run(async () => {
      const body = {
        supplier_name: f.supplier_name.value, invoice_number: f.invoice_number.value, date: f.date.value, due_date: f.due_date.value || undefined,
        supplier_vat_id: f.supplier_vat_id.value, supplier_country: f.supplier_country.value.toUpperCase() || undefined,
        reverse_charge: f.reverse_charge.checked, status: f.status.value, note: f.note.value, lines,
      };
      if (booked) { for (const k of ['supplier_name', 'invoice_number', 'date', 'supplier_vat_id', 'reverse_charge']) delete body[k]; }
      const saved = id === 'new' ? await api('POST', '/expenses', body) : await api('PUT', `/expenses/${id}`, body);
      toast('Gespeichert');
      go(`#/expense/${saved.id}`);
    });
    return h('div', { class: 'space-y-4' },
      title(id === 'new' ? 'Neue Ausgabe' : `Ausgabe ${e.supplier_name}`,
        e.file_id ? btn('Beleg ansehen', () => download(`/files/${e.file_id}`)) : null,
        e.xml_file_id ? btn('E-Rechnung XML', () => download(`/files/${e.xml_file_id}`)) : null,
        id !== 'new' && e.status === 'draft' ? btn('Löschen', () => run(async () => { await api('DELETE', `/expenses/${id}`); go('#/expenses'); }), 'danger') : null,
        btn('Speichern', save, 'primary')),
      booked ? h('p', { class: 'text-xs text-gray-500' }, 'Gebuchter Beleg: Lieferant, Nummer und Datum sind gesperrt (GoBD). Kategorie, Status und Notiz bleiben änderbar.') : null,
      card(h('div', { class: 'grid grid-cols-2 gap-3 lg:grid-cols-4' },
        field('Lieferant', f.supplier_name), field('Rechnungsnr. des Lieferanten', f.invoice_number), field('Rechnungsdatum', f.date), field('Fällig', f.due_date),
        field('USt-IdNr. Lieferant', f.supplier_vat_id), field('Land Lieferant', f.supplier_country, 'z. B. IE für Google/Meta'),
        field('Status', f.status), h('label', { class: 'flex items-end gap-2 pb-2 text-sm' }, f.reverse_charge, 'Reverse Charge (§ 13b) — Rechnung ohne USt aus dem Ausland'))),
      card(linesBox, h('div', { class: 'mt-3' }, sum)), card(field('Notiz', f.note)));
  }

  /* ------------------------------------------------------------------ bank */

  async function bankView() {
    const accounts = await api('GET', '/bank/accounts');
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const year = params.get('year') || today().slice(0, 4);
    const status = params.has('status') ? params.get('status') : 'unmatched';
    const txs = await api('GET', `/bank/transactions?year=${year}${status ? `&status=${status}` : ''}`);
    const addAccount = () => {
      const name = input({ value: 'Geschäftskonto' }); const iban = input({}); const ledger = input({ type: 'number', placeholder: '1200 (SKR03) / 1800 (SKR04)' });
      modal('Bankkonto anlegen', h('div', { class: 'grid grid-cols-2 gap-3' }, field('Name', name), field('IBAN', iban), field('DATEV-Konto', ledger)),
        (close) => [btn('Abbrechen', close), btn('Anlegen', () => run(async () => { await api('POST', '/bank/accounts', { name: name.value, iban: iban.value, ledger_account: ledger.value ? Number(ledger.value) : undefined }); close(); route(); }), 'primary')]);
    };
    const importFor = (a) => pickFile('.xml,.sta,.mt940,.txt,.csv', (file) => run(async () => {
      const r = await api('POST', `/upload/statement?account_id=${a.id}`, file, { contentType: 'application/octet-stream' });
      toast(`${r.format}: ${r.imported} neu, ${r.duplicates} bekannt, ${r.auto_matched} automatisch zugeordnet`);
      if (r.warnings.length) toast(r.warnings.join(' '), 'err');
      route();
    }));
    const matchDialog = async (t) => {
      const sugg = await api('GET', `/bank/transactions/${t.id}/suggestions`);
      const cat = select({}, [['', '— Kategorie ohne Beleg —'], ...META.categories.map((c) => [c.key, c.de])], '');
      modal(`${money(t.amount_cents)} · ${t.counterparty_name || ''}`, h('div', { class: 'space-y-3 text-sm' },
        h('p', { class: 'text-gray-600' }, t.purpose),
        sugg.length ? h('div', { class: 'space-y-2' }, sugg.map((s) => h('div', { class: 'flex items-center justify-between rounded-md border p-2' },
          h('div', {}, h('div', { class: 'font-medium' }, s.label), h('div', { class: 'text-xs text-gray-500' }, `offen ${money(s.open_cents)} · ${s.reasons.join(', ')} · Score ${s.score}`)),
          btn('Zuordnen', () => run(async () => { await api('POST', `/bank/transactions/${t.id}/match`, { kind: s.kind, id: s.id }); document.querySelector('.fixed.inset-0').remove(); route(); }, 'Zugeordnet'), 'primary'))))
          : h('p', { class: 'text-gray-500' }, 'Keine passende offene Rechnung oder Ausgabe gefunden.'),
        h('div', { class: 'flex items-end gap-2 border-t pt-3' }, h('div', { class: 'flex-1' }, field('Direkt buchen (z. B. Kontoführung)', cat)),
          btn('Buchen', () => run(async () => { if (!cat.value) return; await api('POST', `/bank/transactions/${t.id}/categorize`, { category: cat.value }); document.querySelector('.fixed.inset-0').remove(); route(); })),
          btn('Ignorieren', () => run(async () => { await api('POST', `/bank/transactions/${t.id}/categorize`, { ignore: true }); document.querySelector('.fixed.inset-0').remove(); route(); })))));
    };
    return h('div', { class: 'space-y-4' },
      title('Bank', btn('+ Konto', addAccount)),
      h('div', { class: 'grid gap-3 lg:grid-cols-3' }, accounts.map((a) => card(
        h('div', { class: 'font-medium' }, a.name), h('div', { class: 'text-xs text-gray-500' }, a.iban || 'ohne IBAN'),
        h('div', { class: 'mt-3' }, btn('Kontoauszug importieren (CAMT/MT940/CSV)', () => importFor(a), 'primary'))))),
      !accounts.length ? h('p', { class: 'text-sm text-gray-500' }, 'Lege zuerst ein Bankkonto an. Danach Kontoauszüge als camt.053 (XML), MT940 oder CSV aus dem Online-Banking importieren — Zahlungen werden automatisch Rechnungen zugeordnet.') : null,
      h('div', { class: 'flex gap-1 text-xs' }, [['unmatched', 'Offen'], ['matched', 'Zugeordnet'], ['ignored', 'Ignoriert'], ['', 'Alle']].map(([k, l]) => h('a', {
        href: `#/bank?status=${k}&year=${year}`, class: `rounded-full px-3 py-1 font-medium ${status === k ? 'bg-gray-900 text-white' : 'bg-white ring-1 ring-gray-200'}`,
      }, l))),
      table(['Datum', 'Gegenpartei', 'Verwendungszweck', { label: 'Betrag', right: true }, 'Status', ''], txs.map((t) => ({
        t, cells: [date(t.booking_date), t.counterparty_name || '', h('span', { class: 'line-clamp-2 text-xs' }, t.purpose),
          h('span', { class: t.amount_cents < 0 ? 'text-red-700' : 'text-green-700' }, money(t.amount_cents, t.currency)), badge(t.status),
          t.status === 'unmatched' ? btn('zuordnen', (e) => { e.stopPropagation(); run(() => matchDialog(t)); }, 'link')
            : btn('lösen', (e) => { e.stopPropagation(); run(async () => { await api('POST', `/bank/transactions/${t.id}/unmatch`); route(); }); }, 'link')],
      }))));
  }

  /* ------------------------------------------------------------------ recurring */

  async function recurringList() {
    const [list, contacts] = await Promise.all([api('GET', '/recurring'), api('GET', '/contacts')]);
    const name = (cid) => { const c = contacts.find((x) => x.id === cid); return c ? (c.company_name || `${c.first_name || ''} ${c.last_name || ''}`) : '—'; };
    const ivl = { monthly: 'monatlich', quarterly: 'quartalsweise', yearly: 'jährlich' };
    return h('div', {},
      title('Wiederkehrende Rechnungen',
        btn('Fällige jetzt erstellen', () => run(async () => { const r = await api('POST', '/recurring/run'); toast(`${r.created.length} Rechnung(en) erstellt${r.errors.length ? ` · ${r.errors.join('; ')}` : ''}`); }), 'secondary'),
        btn('+ Vorlage', () => go('#/rec/new'), 'primary')),
      h('p', { class: 'mb-3 text-xs text-gray-500' }, 'Für Retainer, Wartungsverträge, Hosting und Lizenzen. Fällige Rechnungen werden beim Öffnen dieses Bereichs, per Knopf oder per API/MCP (POST /recurring/run) erstellt.'),
      table(['Name', 'Kunde', 'Intervall', 'Nächste', { label: 'Netto', right: true }, 'Aktiv'], list.map((r) => ({
        r, cells: [r.name, name(r.contact_id), ivl[r.interval], date(r.next_date), money(r.lines.reduce((s, l) => s + (l.type === 'item' ? Math.round(l.quantity * l.unit_price_cents) : 0), 0)), r.active ? '✓' : '—'],
      })), (x) => go(`#/rec/${x.r.id}`)));
  }

  async function recurringEditor(id) {
    const [list, contacts] = await Promise.all([api('GET', '/recurring'), api('GET', '/contacts')]);
    const r = id === 'new' ? { name: '', active: true, interval: 'monthly', next_date: today(), auto_finalize: false, auto_send: false, bill_period: true, price_mode: 'net', lines: [{ type: 'item', name: '', quantity: 1, unit: 'MON', unit_price_cents: 0, tax_rate: 19 }] } : list.find((x) => x.id === id);
    if (!r) throw new Error('Vorlage nicht gefunden.');
    const f = {
      name: input({ value: r.name }), contact: select({}, [['', '— Kunde —'], ...contacts.map((c) => [c.id, c.company_name || `${c.first_name || ''} ${c.last_name || ''}`])], r.contact_id),
      interval: select({}, [['monthly', 'monatlich'], ['quarterly', 'quartalsweise'], ['yearly', 'jährlich']], r.interval),
      next_date: input({ type: 'date', value: r.next_date }), end_date: input({ type: 'date', value: r.end_date || '' }),
      active: h('input', { type: 'checkbox', checked: r.active }), auto_finalize: h('input', { type: 'checkbox', checked: r.auto_finalize }),
      auto_send: h('input', { type: 'checkbox', checked: r.auto_send }), bill_period: h('input', { type: 'checkbox', checked: r.bill_period }),
    };
    const lines = r.lines.map((l) => ({ ...l }));
    const box = h('div', { class: 'space-y-2' });
    const draw = () => box.replaceChildren(...lines.map((l, i) => h('div', { class: 'grid grid-cols-12 gap-2' },
      h('div', { class: 'col-span-6' }, input({ value: l.name, placeholder: 'Leistung', oninput: (e) => { l.name = e.target.value; } })),
      h('div', { class: 'col-span-1' }, input({ value: l.quantity, oninput: (e) => { l.quantity = Number(e.target.value.replace(',', '.')) || 0; } })),
      h('div', { class: 'col-span-2' }, select({ onchange: (e) => { l.unit = e.target.value; } }, META.units.map((u) => [u.code, u.de]), l.unit)),
      h('div', { class: 'col-span-2' }, input({ value: centsInput(l.unit_price_cents), oninput: (e) => { l.unit_price_cents = parseMoney(e.target.value); } })),
      h('div', { class: 'col-span-1' }, btn('✕', () => { lines.splice(i, 1); draw(); }, 'link')))),
    btn('+ Position', () => { lines.push({ type: 'item', name: '', quantity: 1, unit: 'MON', unit_price_cents: 0, tax_rate: 19 }); draw(); }));
    draw();
    return h('div', { class: 'space-y-4' },
      title(id === 'new' ? 'Neue Vorlage' : r.name,
        id !== 'new' ? btn('Löschen', () => run(async () => { await api('DELETE', `/recurring/${id}`); go('#/recurring'); }), 'danger') : null,
        btn('Speichern', () => run(async () => {
          const body = { name: f.name.value, contact_id: f.contact.value, interval: f.interval.value, next_date: f.next_date.value, end_date: f.end_date.value || undefined,
            active: f.active.checked, auto_finalize: f.auto_finalize.checked, auto_send: f.auto_send.checked, bill_period: f.bill_period.checked, lines };
          if (id === 'new') await api('POST', '/recurring', body); else await api('PUT', `/recurring/${id}`, body);
          go('#/recurring');
        }, 'Gespeichert'), 'primary')),
      card(h('div', { class: 'grid grid-cols-2 gap-3 lg:grid-cols-4' }, field('Name', f.name), field('Kunde', f.contact), field('Intervall', f.interval), field('Nächste Rechnung', f.next_date), field('Ende (optional)', f.end_date),
        h('div', { class: 'col-span-2 flex flex-wrap items-end gap-4 text-sm lg:col-span-3' },
          h('label', { class: 'flex items-center gap-1' }, f.active, 'aktiv'), h('label', { class: 'flex items-center gap-1' }, f.auto_finalize, 'automatisch abschließen'),
          h('label', { class: 'flex items-center gap-1' }, f.auto_send, 'automatisch per E-Mail senden'), h('label', { class: 'flex items-center gap-1' }, f.bill_period, 'Leistungszeitraum drucken')))),
      card(box));
  }

  /* ------------------------------------------------------------------ reports */

  async function reportsView() {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const y = today().slice(0, 4);
    const from = params.get('from') || `${y}-01-01`;
    const to = params.get('to') || today();
    const [vat, pnl, items] = await Promise.all([api('GET', `/reports/vat?from=${from}&to=${to}`), api('GET', `/reports/pnl?from=${from}&to=${to}`), api('GET', '/reports/open-items')]);
    const fromI = input({ type: 'date', value: from }); const toI = input({ type: 'date', value: to });
    const presets = [];
    const m = Number(today().slice(5, 7));
    const prevM = m === 1 ? [Number(y) - 1, 12] : [Number(y), m - 1];
    const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    presets.push(['Vormonat', `${prevM[0]}-${String(prevM[1]).padStart(2, '0')}-01`, `${prevM[0]}-${String(prevM[1]).padStart(2, '0')}-${lastDay(prevM[0], prevM[1])}`]);
    for (let q = 1; q <= 4; q++) presets.push([`Q${q}`, `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`, `${y}-${String(q * 3).padStart(2, '0')}-${lastDay(Number(y), q * 3)}`]);
    presets.push([`Jahr ${y}`, `${y}-01-01`, `${y}-12-31`], [`Jahr ${Number(y) - 1}`, `${Number(y) - 1}-01-01`, `${Number(y) - 1}-12-31`]);
    const kz = [
      ['81', 'Steuerpflichtige Umsätze 19 % (Bemessungsgrundlage)', vat.kz['81'], vat.kz['81_tax']],
      ['86', 'Steuerpflichtige Umsätze 7 %', vat.kz['86'], vat.kz['86_tax']],
      ['41', 'Innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr.', vat.kz['41']],
      ['21', 'Nicht steuerbare sonstige Leistungen EU (§ 18b, Reverse Charge)', vat.kz['21']],
      ['45', 'Übrige nicht steuerbare Umsätze (Leistungsort Drittland)', vat.kz['45']],
      ['43', 'Weitere steuerfreie Umsätze mit Vorsteuerabzug (Ausfuhr)', vat.kz['43']],
      ['46/47', 'Bezogene Leistungen EU-Unternehmer (§ 13b Abs. 1)', vat.kz['46'], vat.kz['47']],
      ['84/85', 'Andere Leistungen nach § 13b', vat.kz['84'], vat.kz['85']],
      ['66', 'Vorsteuer aus Rechnungen', null, vat.kz['66']],
      ['67', 'Vorsteuer aus § 13b-Leistungen', null, vat.kz['67']],
    ];
    const cat = (k) => ((META.categories.find((c) => c.key === k) || {}).de || k);
    return h('div', { class: 'space-y-5' },
      title('Auswertungen'),
      card(h('div', { class: 'flex flex-wrap items-end gap-2' }, field('Von', fromI), field('Bis', toI),
        btn('Anzeigen', () => go(`#/reports?from=${fromI.value}&to=${toI.value}`), 'primary'),
        ...presets.map(([l, f, t]) => btn(l, () => go(`#/reports?from=${f}&to=${t}`))))),
      h('div', { class: 'grid gap-4 lg:grid-cols-2' },
        card(h('h3', { class: 'mb-2 text-sm font-semibold' }, `Umsatzsteuer-Voranmeldung (${vat.basis === 'ist' ? 'Ist' : 'Soll'}-Versteuerung)`),
          h('table', { class: 'w-full text-sm' }, h('tbody', {}, kz.filter((k) => k[2] || k[3]).map((k) => h('tr', { class: 'border-b border-gray-100' },
            h('td', { class: 'py-1 pr-2 font-mono text-xs text-gray-500' }, k[0]), h('td', { class: 'py-1' }, k[1]),
            h('td', { class: 'whitespace-nowrap py-1 pl-2 text-right tabular-nums' }, k[2] != null ? money(k[2]) : ''), h('td', { class: 'whitespace-nowrap py-1 pl-2 text-right tabular-nums' }, k[3] != null ? money(k[3]) : '')))),
            h('tr', { class: 'font-semibold' }, h('td', {}, '83'), h('td', {}, vat.payable_cents >= 0 ? 'Zahllast' : 'Erstattung'), h('td', {}), h('td', { class: 'whitespace-nowrap pl-2 text-right tabular-nums' }, money(vat.payable_cents)))),
          h('p', { class: 'mt-2 text-xs text-gray-500' }, 'Kennzahlen zur Übernahme in ELSTER bzw. zur Abstimmung mit dem Steuerberater. Bitte vor Abgabe prüfen.', ...vat.notes.map((n) => h('span', { class: 'block text-amber-700' }, n)))),
        card(h('h3', { class: 'mb-2 text-sm font-semibold' }, 'Ergebnis (netto)'),
          h('div', { class: 'space-y-1 text-sm' },
            h('div', { class: 'flex justify-between' }, h('span', {}, 'Umsatzerlöse'), h('span', { class: 'tabular-nums' }, money(pnl.revenue_net_cents))),
            ...Object.entries(pnl.expenses_by_category).sort((a, b) => b[1] - a[1]).map(([k, v]) => h('div', { class: 'flex justify-between text-gray-600' }, h('span', {}, `– ${cat(k)}`), h('span', { class: 'tabular-nums' }, money(v)))),
            h('div', { class: 'flex justify-between border-t pt-1 font-semibold' }, h('span', {}, 'Ergebnis'), h('span', { class: `tabular-nums ${pnl.result_cents < 0 ? 'text-red-700' : ''}` }, money(pnl.result_cents)))),
          h('p', { class: 'mt-2 text-xs text-gray-500' }, 'Vereinfachte Sicht nach Rechnungsdatum; ersetzt nicht den Jahresabschluss.'))),
      h('div', {}, h('h3', { class: 'mb-2 text-sm font-semibold' }, 'Offene Posten'),
        table(['Art', 'Nr.', 'Partner', 'Datum', 'Fällig', { label: 'Offen', right: true }, { label: 'Tage überfällig', right: true }], items.map((i) => ({
          i, cells: [i.kind === 'receivable' ? 'Forderung' : 'Verbindlichkeit', i.number || '', i.name, date(i.date), date(i.due_date), money(i.open_cents), i.days_overdue ? String(i.days_overdue) : ''],
        })), (r) => go(r.i.kind === 'receivable' ? `#/doc/${r.i.id}` : `#/expense/${r.i.id}`))));
  }

  /* ------------------------------------------------------------------ export */

  async function exportView() {
    const company = await api('GET', '/company');
    const y = today().slice(0, 4);
    const fromI = input({ type: 'date', value: `${y}-${today().slice(5, 7)}-01` });
    const toI = input({ type: 'date', value: today() });
    const ready = company.datev_consultant_number && company.datev_client_number;
    return h('div', { class: 'space-y-4' },
      title('Export für den Steuerberater'),
      !ready ? h('div', { class: 'rounded-md bg-amber-50 p-3 text-sm text-amber-800' }, 'Für den DATEV-Export fehlen Berater- und Mandantennummer (Einstellungen → Firma).') : null,
      card(h('div', { class: 'flex flex-wrap items-end gap-3' }, field('Von', fromI), field('Bis', toI),
        btn('DATEV-Buchungsstapel (CSV)', () => download(`/export/datev?from=${fromI.value}&to=${toI.value}`), 'primary'),
        btn('Steuerberater-Paket (ZIP: DATEV + alle Belege)', () => download(`/export/package?from=${fromI.value}&to=${toI.value}`))),
      h('p', { class: 'mt-3 text-xs text-gray-500' }, `Kontenrahmen ${company.chart}. Der Buchungsstapel bucht Ausgangsrechnungen gegen Erlös-Automatikkonten, Ausgaben mit Vorsteuer-Schlüssel und Zahlungen gegen das Bankkonto. Das Paket enthält zusätzlich jede archivierte Rechnung (PDF/XML), jeden Beleg, eine Belegliste und Hinweise zu fehlenden Belegen.`)));
  }

  /* ------------------------------------------------------------------ settings */

  async function settingsView() {
    const [c, s] = await Promise.all([api('GET', '/company'), api('GET', '/settings')]);
    const fields = [
      ['name', 'Firmenname'], ['legal_form', 'Rechtsform'], ['tagline', 'Zusatz (z. B. „IT Solutions“)'], ['street', 'Straße'], ['zip', 'PLZ'], ['city', 'Ort'], ['country', 'Land (ISO)'],
      ['managing_directors', 'Geschäftsführer'], ['register_court', 'Registergericht'], ['register_number', 'Registernummer (HRB)'],
      ['vat_id', 'USt-IdNr.'], ['tax_number', 'Steuernummer'], ['email', 'E-Mail'], ['einvoice_email', 'E-Rechnungs-Adresse (optional)'], ['phone', 'Telefon'],
      ['contact_person', 'Ansprechpartner'], ['website', 'Website'], ['bank_name', 'Bank'], ['iban', 'IBAN'], ['bic', 'BIC'], ['account_holder', 'Kontoinhaber'],
      ['datev_consultant_number', 'DATEV Beraternummer'], ['datev_client_number', 'DATEV Mandantennummer'], ['default_payment_days', 'Zahlungsziel Standard (Tage)'],
      ['accent_color', 'Akzentfarbe (#hex)'],
    ];
    const ctl = {};
    for (const [k] of fields) ctl[k] = input({ value: c[k] ?? '' });
    ctl.small_business = h('input', { type: 'checkbox', checked: c.small_business });
    ctl.vat_basis = select({}, [['soll', 'Soll-Versteuerung (nach Rechnungsdatum)'], ['ist', 'Ist-Versteuerung (nach Zahlung)']], c.vat_basis);
    ctl.chart = select({}, [['SKR03', 'SKR03'], ['SKR04', 'SKR04']], c.chart);
    ctl.document_language = select({}, [['de', 'Deutsch'], ['en', 'English']], c.document_language);
    ctl.fiscal_year_start_month = input({ type: 'number', min: 1, max: 12, value: c.fiscal_year_start_month });
    let logo = c.logo_data_url;
    const logoInfo = h('span', { class: 'text-xs text-gray-500' }, logo ? 'Logo gesetzt' : 'kein Logo');
    const saveCompany = () => run(async () => {
      const body = {};
      for (const [k] of fields) body[k] = ctl[k].value;
      for (const k of ['datev_consultant_number', 'datev_client_number', 'default_payment_days']) body[k] = body[k] === '' ? undefined : Number(body[k]);
      Object.assign(body, { small_business: ctl.small_business.checked, vat_basis: ctl.vat_basis.value, chart: ctl.chart.value, document_language: ctl.document_language.value,
        fiscal_year_start_month: Number(ctl.fiscal_year_start_month.value) || 1, logo_data_url: logo || undefined });
      await api('PUT', '/company', body);
    }, 'Firmendaten gespeichert');

    const series = {};
    for (const t of ['invoice', 'credit_note', 'quote']) {
      series[t] = { pattern: input({ value: s.series[t].pattern }), reset: select({}, [['yearly', 'jährlich'], ['monthly', 'monatlich'], ['never', 'nie']], s.series[t].reset) };
    }
    const texts = {};
    for (const k of Object.keys(s.texts)) texts[k] = textarea({ value: s.texts[k], rows: k.startsWith('email_body') ? 6 : 2 });
    const autoShop = h('input', { type: 'checkbox', checked: s.auto_invoice_shop_orders });
    const personal = h('input', { type: 'checkbox', checked: s.datev_use_personal_accounts });
    const overrides = textarea({ rows: 4, value: Object.entries(s.account_overrides).map(([k, v]) => `${k}=${v}`).join('\n'), placeholder: 'rev:domestic:19=8400\nexp:software=4964\nbu:rc19=94' });
    const saveSettings = () => run(async () => {
      const ov = {};
      for (const line of overrides.value.split('\n')) { const [k, v] = line.split('='); if (k && v) ov[k.trim()] = Number(v.trim()); }
      await api('PUT', '/settings', {
        series: Object.fromEntries(Object.entries(series).map(([t, x]) => [t, { pattern: x.pattern.value, reset: x.reset.value }])),
        texts: Object.fromEntries(Object.entries(texts).map(([k, x]) => [k, x.value])),
        auto_invoice_shop_orders: autoShop.checked, datev_use_personal_accounts: personal.checked, account_overrides: ov,
      });
    }, 'Einstellungen gespeichert');

    const lxKey = input({ type: 'password', placeholder: 'Lexware Office API-Schlüssel' });
    const lxSince = input({ type: 'date' });
    const lxStatus = h('div', { class: 'text-xs text-gray-600' });
    const pollJob = async (id) => {
      const j = await api('GET', `/jobs/${id}`);
      lxStatus.textContent = `${j.status}: ${Object.entries(j.progress).map(([k, v]) => `${k} ${v}`).join(' · ')}${j.error ? ` — ${j.error}` : ''}${j.messages.length ? ` — ${j.messages.length} Hinweise` : ''}`;
      if (j.status === 'running') setTimeout(() => pollJob(id), 2500);
    };
    const verifyOut = h('span', { class: 'text-xs' });

    return h('div', { class: 'space-y-5' },
      title('Einstellungen'),
      card(h('h3', { class: 'mb-3 text-sm font-semibold' }, 'Firma (Pflichtangaben auf Rechnungen, § 14 UStG / § 35a GmbHG)'),
        h('div', { class: 'grid grid-cols-2 gap-3 lg:grid-cols-4' }, fields.map(([k, l]) => field(l, ctl[k])),
          field('Kontenrahmen', ctl.chart), field('Versteuerung', ctl.vat_basis), field('Dokumentsprache', ctl.document_language), field('Beginn Wirtschaftsjahr (Monat)', ctl.fiscal_year_start_month),
          h('label', { class: 'flex items-end gap-2 pb-2 text-sm' }, ctl.small_business, 'Kleinunternehmer (§ 19 UStG)'),
          h('div', { class: 'flex items-end gap-2' }, btn('Logo hochladen', () => pickFile('image/png,image/jpeg', (file) => {
            if (file.size > 500000) { toast('Logo bitte unter 500 KB', 'err'); return; }
            const rd = new FileReader();
            rd.onload = () => { logo = rd.result; logoInfo.textContent = `${file.name} (wird beim Speichern übernommen)`; };
            rd.readAsDataURL(file);
          })), logoInfo)),
        h('div', { class: 'mt-3' }, btn('Firmendaten speichern', saveCompany, 'primary'))),
      card(h('h3', { class: 'mb-3 text-sm font-semibold' }, 'Nummernkreise & Texte'),
        h('div', { class: 'grid gap-3 lg:grid-cols-3' }, Object.entries(series).map(([t, x]) => h('div', { class: 'space-y-2' }, field(`${TYPE[t]} — Muster`, x.pattern, '{YYYY} {YY} {MM} {SEQ:4}'), field('Zähler zurücksetzen', x.reset)))),
        h('div', { class: 'mt-3 grid gap-3 lg:grid-cols-2' }, Object.entries(texts).map(([k, x]) => field(k, x, k.startsWith('email') ? 'Platzhalter: {type} {number} {company} {amount} {link} {due}' : undefined))),
        h('div', { class: 'mt-3 grid gap-3 lg:grid-cols-2' },
          h('label', { class: 'flex items-center gap-2 text-sm' }, autoShop, 'Shop-Bestellungen bei „abgeschlossen“ automatisch abrechnen'),
          h('label', { class: 'flex items-center gap-2 text-sm' }, personal, 'DATEV: Personenkonten (Debitoren/Kreditoren) verwenden'),
          field('Konten-Überschreibungen (für den Steuerberater)', overrides, 'Ein Eintrag je Zeile, z. B. exp:software=4964')),
        h('div', { class: 'mt-3' }, btn('Einstellungen speichern', saveSettings, 'primary'))),
      card(h('h3', { class: 'mb-2 text-sm font-semibold' }, 'Import aus Lexware Office'),
        h('p', { class: 'mb-3 text-xs text-gray-500' }, 'Übernimmt Kontakte, Artikel sowie Rechnungen und Gutschriften (mit dem Original-PDF aus Lexware). Der Schlüssel wird nur für diesen Import verwendet und nicht gespeichert. Mehrfaches Ausführen ist sicher.'),
        h('div', { class: 'flex flex-wrap items-end gap-2' }, h('div', { class: 'w-80' }, field('API-Schlüssel', lxKey)), field('Belege ab (optional)', lxSince),
          btn('Import starten', () => run(async () => {
            const j = await api('POST', '/import/lexware', { api_key: lxKey.value, since: lxSince.value || undefined });
            lxKey.value = '';
            pollJob(j.id);
          }), 'primary')), lxStatus),
      card(h('h3', { class: 'mb-2 text-sm font-semibold' }, 'Schnittstellen'),
        h('ul', { class: 'list-disc space-y-1 pl-5 text-sm text-gray-700' },
          h('li', {}, 'REST-API: /api/plugin/finance/… — API-Schlüssel (Admin) mit Scope finance:read / finance:write unter Einstellungen → API-Schlüssel anlegen.'),
          h('li', {}, 'Verkäufe aus Websites / Lizenzserver: POST /api/plugin/finance/sales (API-Schlüssel) oder signiert an /api/plugin/finance/inbound/sale (FINANCE_INBOUND_SECRET). Idempotent über source + external_id.'),
          h('li', {}, 'Webhooks (Einstellungen → Webhooks): invoice.finalized, invoice.paid, invoice.cancelled, invoice.dunned, credit_note.finalized, quote.finalized/accepted/rejected, document.sent, expense.created.'),
          h('li', {}, 'MCP für askTheodor/Claude: npx astrobaas-mcp — Werkzeuge finance_* (Übersicht, Rechnungen, Zahlungen, Ausgaben, USt).'))),
      card(h('h3', { class: 'mb-2 text-sm font-semibold' }, 'GoBD-Protokoll'),
        h('p', { class: 'mb-2 text-xs text-gray-500' }, 'Jede Änderung wird in einer Hash-Kette protokolliert. Die Prüfung erkennt nachträglich veränderte oder gelöschte Einträge.'),
        h('div', { class: 'flex items-center gap-3' }, btn(`Protokoll ${today().slice(0, 4)} prüfen`, () => run(async () => {
          const r = await api('GET', `/log/verify?year=${today().slice(0, 4)}`);
          verifyOut.textContent = r.ok ? `✓ ${r.entries} Einträge, Kette intakt` : `✗ Kette unterbrochen bei ${r.broken_at}`;
          verifyOut.className = `text-xs ${r.ok ? 'text-green-700' : 'text-red-700'}`;
        })), verifyOut)));
  }

  route();
})();
