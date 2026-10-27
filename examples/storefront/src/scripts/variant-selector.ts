/**
 * The browser half of components/VariantSelector.astro.
 *
 * Turns the no-script select into one radio group per option, and keeps the
 * page in step with the choice: the price, the stock line, the SKU, the image,
 * the buy button and the address (?variant=<id>). Every decision about which
 * values can be chosen is lib/variant-selection.ts; every word and price shown
 * was formatted at build time (lib/variant-view.ts). This file only moves them.
 */
import {
  axisStates, blockedText, droppedChoices, initialSelection, matchVariant, missingAxes, reconcileSelection,
  swatchColor, type VariantSelection,
} from '../lib/variant-selection';
import type { PickerData, VariantView } from '../lib/variant-view';

const TONES = ['stock-in', 'stock-low', 'stock-out'];

export function mountVariantSelector(root: HTMLElement): void {
  const raw = root.querySelector('[data-variant-data]')?.textContent;
  if (!raw) return;
  let data: PickerData;
  try { data = JSON.parse(raw) as PickerData; } catch { return; }
  const { axes, variants, views } = data;
  if (!axes.length) return;

  const scope = root.closest<HTMLElement>('[data-product-root]') ?? document.body;
  const select = root.querySelector<HTMLSelectElement>('[data-variant-select]');
  const groups = root.querySelector<HTMLElement>('[data-variant-groups]');
  const fallback = root.querySelector<HTMLElement>('[data-variant-fallback]');
  const hint = root.querySelector<HTMLElement>('[data-variant-hint]');
  const live = root.querySelector<HTMLElement>('[data-variant-live]');
  const skuOut = root.querySelector<HTMLElement>('[data-variant-sku]');
  const price = scope.querySelector<HTMLElement>('[data-variant-price]');
  const stock = scope.querySelector<HTMLElement>('[data-stock]');
  const image = scope.querySelector<HTMLImageElement>('[data-variant-image]');
  const buy = scope.querySelector<HTMLButtonElement>('[data-variant-buy]');
  const fieldsets = [...root.querySelectorAll<HTMLFieldSetElement>('fieldset[data-axis]')];
  if (!groups || fieldsets.length !== axes.length) return;

  // What the page showed before any choice, to return to when the choice is
  // incomplete again.
  const base = {
    price: price ? [...price.childNodes].map((n) => n.cloneNode(true)) : [],
    stockText: stock?.textContent ?? '',
    stockClass: stock?.className ?? '',
    sku: skuOut?.textContent ?? '',
    image: image?.getAttribute('src') ?? '',
    buyDisabled: buy?.disabled ?? false,
  };

  const fromUrl = new URL(location.href).searchParams.get('variant');
  let selection: VariantSelection = initialSelection(
    axes, variants, fromUrl && views[fromUrl] ? fromUrl : root.dataset.selected || null,
  );

  function renderPrice(view: VariantView | null) {
    if (!price) return;
    if (!view) { price.replaceChildren(...base.price.map((n) => n.cloneNode(true))); return; }
    const parts: Node[] = [];
    if (view.was) parts.push(hidden('Sale price '));
    parts.push(document.createTextNode(view.price));
    if (view.was) {
      const del = document.createElement('del');
      del.append(hidden('Was '), document.createTextNode(view.was));
      parts.push(document.createTextNode(' '), del);
    }
    price.replaceChildren(...parts);
  }

  // Set when a change of an earlier option dropped a value the shopper chose.
  let dropped = '';

  function render(announce: boolean) {
    fieldsets.forEach((fs, i) => {
      const states = axisStates(axes, variants, selection, i);
      const chosen = selection[axes[i].name];
      const current = fs.querySelector<HTMLElement>('[data-axis-current]');
      if (current) current.textContent = chosen ? `: ${chosen}` : '';
      fs.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((input, j) => {
        const s = states[j];
        if (!s) return;
        input.disabled = !s.selectable;
        input.checked = chosen === s.value;
        const note = input.closest('label')?.querySelector<HTMLElement>('[data-note]');
        if (note) note.textContent = s.reason ? blockedText(axes, selection, i, s.reason) : '';
      });
    });

    const match = matchVariant(axes, variants, selection);
    const view = match ? views[match.id] ?? null : null;
    if (select) select.value = view ? view.id : '';

    renderPrice(view);
    if (stock) {
      if (view) {
        stock.textContent = view.stock.label;
        stock.classList.remove(...TONES);
        stock.classList.add(`stock-${view.stock.tone}`);
      } else {
        stock.textContent = base.stockText;
        stock.className = base.stockClass;
      }
    }
    if (skuOut) {
      skuOut.textContent = view ? view.sku : base.sku;
      const line = skuOut.parentElement;
      if (line) line.hidden = !skuOut.textContent;
    }
    if (image) {
      const src = view?.image || base.image;
      if (src && image.getAttribute('src') !== src) image.setAttribute('src', src);
    }
    if (buy) buy.disabled = base.buyDisabled || !(view && view.buyable);

    const missing = missingAxes(axes, selection);
    const choose = missing.length && !(view && view.buyable) ? `Choose ${missing.map((m) => m.toLowerCase()).join(' and ')}` : '';
    if (hint) hint.textContent = [dropped, choose].filter(Boolean).join('. ');

    const url = new URL(location.href);
    if (view) url.searchParams.set('variant', view.id);
    else url.searchParams.delete('variant');
    if (url.href !== location.href) history.replaceState(history.state, '', url);

    if (announce && live) {
      live.textContent = view
        ? `${view.label}: ${view.price}${view.was ? `, was ${view.was}` : ''}. ${view.stock.label}.`
        : hint?.textContent ?? '';
    }
  }

  fieldsets.forEach((fs, i) => {
    fs.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input?.type !== 'radio' || !input.checked) return;
      const wanted = { ...selection, [axes[i].name]: input.value };
      selection = reconcileSelection(axes, variants, wanted);
      // Say what went, so a size the shopper picked never vanishes silently.
      const gone = droppedChoices(axes, wanted, selection);
      const given = axes.slice(0, i + 1).map((a) => selection[a.name]).filter(Boolean).join(' / ');
      dropped = Object.values(gone).map((v) => `${v} is not available in ${given}`).join('. ');
      render(true);
    });
  });

  // Swatch colours: through the CSSOM, never a style attribute. The strict CSP
  // (no 'unsafe-inline') refuses a style attribute, written in markup or by
  // script, but not a property set on element.style; and only a colour the
  // shared rule accepts gets that far.
  paintSwatches(root);

  // Script is running: the radio groups replace the select.
  fallback?.setAttribute('hidden', '');
  groups.hidden = false;
  fieldsets.forEach((fs) => { fs.disabled = false; });
  selection = reconcileSelection(axes, variants, selection);
  render(false);
}

/** Copy each swatch's data-swatch-color into --ab-swatch-color, if it is a hex colour. */
export function paintSwatches(root: ParentNode): number {
  let painted = 0;
  for (const el of root.querySelectorAll<HTMLElement>('[data-swatch-color]')) {
    const color = swatchColor(el.dataset.swatchColor);
    if (!color) continue;
    el.style.setProperty('--ab-swatch-color', color);
    painted += 1;
  }
  return painted;
}

function hidden(text: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'visually-hidden';
  s.textContent = text;
  return s;
}
