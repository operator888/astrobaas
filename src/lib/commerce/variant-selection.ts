/**
 * Choosing a variant, option by option: which values a shopper may pick.
 *
 * Pure and SELF-CONTAINED — no imports — on purpose. It runs in three places
 * that must agree:
 *
 * - any storefront, through `astrobaas/client` (re-exported there);
 * - the storefront starter, which pins the PUBLISHED package and so carries a
 *   byte-identical copy at `examples/storefront/src/lib/variant-selection.ts`
 *   (`tests/variant-selection.test.mjs` fails the moment the two differ);
 * - the unit tests, which drive both copies through the same cases.
 *
 * ## The rule
 *
 * Options are chosen in order — colour, then size. The values offered for an
 * option depend only on the choices made EARLIER in that order:
 *
 * - a value no enabled variant has, together with the earlier choices, is
 *   `unavailable` ("Not available in Red") — a combination that does not exist
 *   is never offered as if it might;
 * - a value whose every matching variant cannot be bought is `sold-out`;
 * - anything else is selectable.
 *
 * Disabled variants are not passed in at all (see `toSelectable`): a variant
 * the merchant switched off is not a combination that exists for a shopper.
 *
 * Nothing here decides whether a unit can be bought. `buyable` comes from the
 * CMS's own `stock_status.purchasable` — the checkout's rule, derived on read —
 * so the picker cannot offer what an order would refuse, or the reverse.
 */

/** A variant as the picker needs it. Build one with `toSelectable`. */
export interface SelectableVariant {
  id: string;
  /** Attribute name to value, e.g. `{ Colour: 'Red', Size: 'M' }`. */
  options: Record<string, string>;
  /** Can one unit be ordered now? From the CMS's `stock_status.purchasable`. */
  buyable: boolean;
}

/** One option to choose, with its values in display order. */
export interface VariantAxis {
  name: string;
  values: string[];
}

/** Why a value cannot be chosen. */
export type OptionBlock = 'unavailable' | 'sold-out';

export interface OptionState {
  value: string;
  selectable: boolean;
  /** null when selectable. */
  reason: OptionBlock | null;
}

/** The current choice: attribute name to chosen value. Absent = not chosen. */
export type VariantSelection = Record<string, string>;

/** The wire shape `toSelectable` reads — a variant as `GET /api/products/{ref}` sends it. */
export interface VariantLike {
  id: string;
  options?: Record<string, string> | null;
  enabled?: boolean;
  in_stock?: boolean;
  stock_status?: { purchasable?: boolean } | null;
}

/**
 * The variant as the picker sees it, or null when it must not be offered.
 *
 * A disabled variant is not a combination that exists for a shopper. A CMS
 * older than `stock_status` sends only the stored `in_stock`, and then that
 * flag is all there is.
 */
export function toSelectable(v: VariantLike): SelectableVariant | null {
  if (!v || typeof v.id !== 'string' || v.enabled === false) return null;
  const options: Record<string, string> = {};
  for (const [k, val] of Object.entries(v.options ?? {})) {
    if (typeof val === 'string' && val !== '') options[k] = val;
  }
  if (!Object.keys(options).length) return null;
  const buyable = v.stock_status ? v.stock_status.purchasable !== false : v.in_stock !== false;
  return { id: v.id, options, buyable };
}

/** Every variant of a product a shopper may see, in the CMS's order. */
export function selectableVariants(variants: readonly VariantLike[] | null | undefined): SelectableVariant[] {
  const out: SelectableVariant[] = [];
  for (const v of variants ?? []) {
    const s = toSelectable(v);
    if (s) out.push(s);
  }
  return out;
}

/**
 * The options to choose, in order, each with the values some variant uses.
 *
 * The order is the merchant's: the product's `attributes` list (colour before
 * size because that is how they entered it), and within one attribute its
 * `values` order. An option key a variant uses that no attribute names is
 * appended, in the order variants first use it — it still has to be choosable.
 * A value no variant uses is dropped: offering it could only ever say "no".
 */
export function variantAxes(
  variants: readonly SelectableVariant[],
  attributes?: readonly { name: string; values?: readonly string[] }[] | null,
): VariantAxis[] {
  const used = new Map<string, string[]>();
  for (const v of variants) {
    for (const [k, val] of Object.entries(v.options)) {
      const list = used.get(k) ?? [];
      if (!list.includes(val)) list.push(val);
      used.set(k, list);
    }
  }
  const axes: VariantAxis[] = [];
  for (const a of attributes ?? []) {
    const seen = used.get(a?.name);
    if (!seen || axes.some((x) => x.name === a.name)) continue;
    const ordered = (a.values ?? []).filter((x) => seen.includes(x));
    axes.push({ name: a.name, values: [...ordered, ...seen.filter((x) => !ordered.includes(x))] });
  }
  for (const [name, values] of used) {
    if (!axes.some((x) => x.name === name)) axes.push({ name, values });
  }
  return axes;
}

function matches(v: SelectableVariant, choices: [string, string][]): boolean {
  return choices.every(([k, val]) => v.options[k] === val);
}

/** The choices made on axes before `index`, as pairs. */
function earlier(axes: readonly VariantAxis[], selection: VariantSelection, index: number): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < index; i++) {
    const val = selection[axes[i].name];
    if (typeof val === 'string') out.push([axes[i].name, val]);
  }
  return out;
}

/** Each value of axis `index`, judged against the choices made before it. */
export function axisStates(
  axes: readonly VariantAxis[],
  variants: readonly SelectableVariant[],
  selection: VariantSelection,
  index: number,
): OptionState[] {
  const axis = axes[index];
  if (!axis) return [];
  const before = earlier(axes, selection, index);
  return axis.values.map((value) => {
    const candidates = variants.filter((v) => v.options[axis.name] === value && matches(v, before));
    if (!candidates.length) return { value, selectable: false, reason: 'unavailable' as const };
    if (!candidates.some((v) => v.buyable)) return { value, selectable: false, reason: 'sold-out' as const };
    return { value, selectable: true, reason: null };
  });
}

/** Every axis's states. */
export function optionStates(
  axes: readonly VariantAxis[],
  variants: readonly SelectableVariant[],
  selection: VariantSelection,
): OptionState[][] {
  return axes.map((_, i) => axisStates(axes, variants, selection, i));
}

/**
 * The selection made consistent, axis by axis, in order.
 *
 * - A choice that is not one of the axis's values, or that the earlier choices
 *   make unavailable or sold out, is dropped — so changing the colour clears a
 *   size that colour does not come in, instead of leaving a dead combination.
 * - An axis with exactly ONE selectable value, and NO choice of the shopper's
 *   on it, is chosen for them: there is nothing to decide. A value the shopper
 *   picked themselves is never swapped for another — if it is dropped, the
 *   option is left empty for them to choose again (`droppedChoices` names it),
 *   because silently turning their L into an M is how the wrong size ships.
 *
 * Keys that name no axis are dropped.
 */
export function reconcileSelection(
  axes: readonly VariantAxis[],
  variants: readonly SelectableVariant[],
  selection: VariantSelection,
): VariantSelection {
  const out: VariantSelection = {};
  for (let i = 0; i < axes.length; i++) {
    const states = axisStates(axes, variants, out, i);
    const chosen = selection[axes[i].name];
    const state = states.find((s) => s.value === chosen);
    if (state?.selectable) {
      out[axes[i].name] = state.value;
      continue;
    }
    if (typeof chosen === 'string') continue;
    const open = states.filter((s) => s.selectable);
    if (open.length === 1) out[axes[i].name] = open[0].value;
  }
  return out;
}

/**
 * The variant the selection names, or null while it names none.
 *
 * A variant is named when every axis agrees: the chosen value equals the
 * variant's, and an axis the variant does not use is left unchosen. Returns a
 * sold-out variant too — the caller shows it as sold out; `reconcileSelection`
 * is what keeps a shopper from choosing one.
 */
export function matchVariant(
  axes: readonly VariantAxis[],
  variants: readonly SelectableVariant[],
  selection: VariantSelection,
): SelectableVariant | null {
  return variants.find((v) => axes.every((a) => v.options[a.name] === selection[a.name])) ?? null;
}

/** The selection that names `variant` exactly. */
export function selectionFor(variant: Pick<SelectableVariant, 'options'> | null | undefined): VariantSelection {
  return variant ? { ...variant.options } : {};
}

/**
 * The starting selection: the variant named in the URL (`?variant=<id>`)
 * when it is one this picker offers, else nothing — then made consistent, so
 * a link to a sold-out variant opens with the parts that are still on sale.
 */
export function initialSelection(
  axes: readonly VariantAxis[],
  variants: readonly SelectableVariant[],
  variantId: string | null | undefined,
): VariantSelection {
  const named = variantId ? variants.find((v) => v.id === variantId) : undefined;
  return reconcileSelection(axes, variants, selectionFor(named));
}

/**
 * The choices `reconcileSelection` dropped: option name to the value the
 * shopper had picked, so the page can say "L is not available in Red".
 */
export function droppedChoices(
  axes: readonly VariantAxis[],
  before: VariantSelection,
  after: VariantSelection,
): VariantSelection {
  const out: VariantSelection = {};
  for (const a of axes) {
    const was = before[a.name];
    if (typeof was === 'string' && after[a.name] !== was) out[a.name] = was;
  }
  return out;
}

/** The axes still to choose, in order — for a "Choose a size" prompt. */
export function missingAxes(axes: readonly VariantAxis[], selection: VariantSelection): string[] {
  return axes.filter((a) => typeof selection[a.name] !== 'string').map((a) => a.name);
}

/** "Red / M", in axis order. */
export function selectionLabel(axes: readonly VariantAxis[], options: VariantSelection): string {
  return axes.map((a) => options[a.name]).filter((x): x is string => typeof x === 'string' && x !== '').join(' / ');
}

/**
 * The words a shopper reads beside a value that cannot be chosen.
 *
 * "Sold out" on its own when nothing is chosen before it, else with the
 * earlier choices it depends on: "Sold out in Red", "Not available in Red".
 * English, like the starter; a theme in another language maps `reason` itself.
 */
export function blockedText(
  axes: readonly VariantAxis[],
  selection: VariantSelection,
  index: number,
  reason: OptionBlock,
): string {
  const given = earlier(axes, selection, index).map(([, v]) => v).join(' / ');
  const head = reason === 'sold-out' ? 'Sold out' : 'Not available';
  return given ? `${head} in ${given}` : head;
}

/*
 * Swatches: a second way to draw an option's values.
 *
 * The merchant stores a colour (`#rrggbb`) or an image per value on the
 * product's attribute (`attributes[].swatches`), and may mark the attribute
 * `display: 'swatch'`. The CMS validates both on save; they are checked again
 * here because a storefront puts the colour into CSS and the image into an
 * <img>, and a copy of this file may be reading a CMS it did not come from.
 */

/** A swatch as a picker draws it. */
export interface Swatch {
  /** `#rrggbb`, lower case, or null. */
  color: string | null;
  /** A media reference (`/path` or `https://`), or null. */
  image: string | null;
  /**
   * True when the colour is too pale to stand out against a white page
   * (under 3:1, WCAG 1.4.11): draw it with a darker border.
   */
  light: boolean;
}

/** The attribute shape `swatchAxes` reads — `attributes[]` as the CMS sends it. */
export interface SwatchAttributeLike {
  name: string;
  display?: string | null;
  swatches?: Record<string, { color?: unknown; image?: unknown } | null | undefined> | null;
}

/** `#rgb` or `#rrggbb` as lower-case `#rrggbb`; anything else is null. */
export function swatchColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const hex = m[1].toLowerCase();
  return '#' + (hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex);
}

/** A same-site path or an https URL, with nothing that could leave an attribute; else null. */
export function swatchImage(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 1000 || /[\s"'<>\\`()]/.test(s)) return null;
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  return /^https:\/\/[^/]/i.test(s) ? s : null;
}

/** Is this colour under 3:1 against white? False for anything not a hex colour. */
export function isLightColor(hex: string): boolean {
  const c = swatchColor(hex);
  if (!c) return false;
  const lin = (i: number) => {
    const x = parseInt(c.slice(i, i + 2), 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  return 1.05 / (l + 0.05) < 3;
}

/** One value's swatch, or null when it has neither a usable colour nor image. */
export function swatchOf(raw: { color?: unknown; image?: unknown } | null | undefined): Swatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const color = swatchColor(raw.color);
  const image = swatchImage(raw.image);
  if (!color && !image) return null;
  return { color, image, light: color ? isLightColor(color) : false };
}

/**
 * Per axis: null to draw it as buttons, or each value's swatch to draw it as
 * swatches (a value with none is drawn as its words in a swatch-sized tile).
 *
 * An axis is drawn as swatches when its attribute is marked
 * `display: 'swatch'`, or when EVERY value the picker offers has a swatch —
 * half the colours as dots and half as words would read as two options.
 */
export function swatchAxes(
  axes: readonly VariantAxis[],
  attributes?: readonly SwatchAttributeLike[] | null,
): (Record<string, Swatch | null> | null)[] {
  return axes.map((axis) => {
    const attr = (attributes ?? []).find((a) => a && a.name === axis.name);
    if (!attr) return null;
    const map: Record<string, Swatch | null> = {};
    let all = axis.values.length > 0;
    for (const value of axis.values) {
      const sw = attr.swatches && typeof attr.swatches === 'object' ? swatchOf(attr.swatches[value]) : null;
      map[value] = sw;
      if (!sw) all = false;
    }
    return attr.display === 'swatch' || all ? map : null;
  });
}
