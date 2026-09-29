/**
 * The header search box: suggestions as you type, from the CMS.
 *
 * ARIA 1.2 "list autocomplete", the same pattern as the CMS's own search box:
 * focus stays in the input, the highlighted option is announced through
 * aria-activedescendant, Up/Down move, Enter opens the highlighted suggestion
 * or — with none highlighted — submits the form to /search/, Escape closes.
 *
 * Without JavaScript the form still submits to /search/, which lists results.
 * Suggestions are built with textContent: product names are shop data.
 */
import { cms } from './shop-api';
import { formatMoney } from '../lib/money';

interface Suggestion { label: string; detail: string; href: string }

export function mountSearchBox(root: HTMLElement, currency: string): void {
  const input = root.querySelector<HTMLInputElement>('input[type="search"]');
  const list = root.querySelector<HTMLUListElement>('[role="listbox"]');
  const status = root.querySelector<HTMLElement>('[role="status"]');
  if (!input || !list || !status) return;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');

  let items: Suggestion[] = [];
  let active = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = '';

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const highlight = (i: number) => {
    active = i;
    [...list.children].forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${i}`);
  };
  const render = () => {
    list.replaceChildren(...items.map((it, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const name = document.createElement('span');
      name.textContent = it.label;
      const detail = document.createElement('span');
      detail.className = 'suggest-detail';
      detail.textContent = it.detail;
      li.append(name, detail);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); location.assign(it.href); });
      return li;
    }));
    status.textContent = items.length ? `${items.length} suggestion${items.length === 1 ? '' : 's'}, use the up and down arrows to choose` : '';
    if (items.length) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } else close();
    active = -1;
  };

  const load = async (q: string) => {
    latest = q;
    try {
      const params = new URLSearchParams({ q, types: 'searches,products,categories' });
      const d = await cms.request<{
        searches?: string[];
        products?: { name: string; slug: string; price_cents: number }[];
        categories?: { name: string; slug: string; count: number }[];
      }>('GET', `/api/search/suggest?${params}`);
      if (q !== latest) return; // a newer keystroke owns the list
      items = [
        // Popular searches (when the shop has them switched on) lead to /search/.
        ...(d.searches ?? []).map((s) => ({ label: s, detail: 'Search', href: `/search/?q=${encodeURIComponent(s)}` })),
        ...(d.categories ?? []).map((c) => ({ label: c.name, detail: c.count === 1 ? '1 product' : `${c.count} products`, href: `/shop/${encodeURIComponent(c.slug)}/` })),
        ...(d.products ?? []).map((p) => ({ label: p.name, detail: formatMoney(p.price_cents, currency), href: `/product/${encodeURIComponent(p.slug)}/` })),
      ];
      render();
    } catch {
      /* offline, or an older CMS without suggestions: the form still searches */
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { items = []; close(); status.textContent = ''; return; }
    timer = setTimeout(() => void load(q), 180);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      if (list.hidden) render();
      highlight((active + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      highlight(active <= 0 ? items.length - 1 : active - 1);
    } else if (e.key === 'Enter' && active >= 0 && !list.hidden) {
      e.preventDefault();
      location.assign(items[active].href);
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault();
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
}
