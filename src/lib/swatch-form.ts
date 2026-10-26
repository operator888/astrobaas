/**
 * The product editor's swatch state, kept beside the attributes textarea.
 *
 * The editor edits attributes as text (`Colour: Red, Blue`), and text has no
 * room for a colour per value — so the swatches, the "show as swatches" mark
 * and the `visible` flag live in a map keyed by attribute name and value, and
 * are put back onto the attributes the text parses to when the form is saved.
 *
 * Why a separate, pure module: the text round-trip used to rebuild every
 * attribute as `{ name, values, visible: true }`, so anything the text cannot
 * spell was dropped on the next save without a word (a hidden attribute came
 * back visible). Swatches would have gone the same way. Pure, so a test drives
 * load -> edit the text -> save and checks nothing is lost.
 *
 * The server validates on save (`swatchProblems` in product-fields.ts); this
 * only carries what the merchant typed, so a bad value is refused with its
 * name rather than vanishing here.
 */

export interface SwatchInput {
  color?: string;
  image?: string;
}

export interface AttributeMeta {
  /** Draw this option as swatches. */
  swatch: boolean;
  /** The stored `visible` flag; the text form cannot show it. */
  visible: boolean;
  /** Value -> what the merchant entered. */
  swatches: Record<string, SwatchInput>;
}

export type SwatchFormState = Record<string, AttributeMeta>;

interface AttributeLike {
  name?: unknown;
  values?: unknown;
  visible?: unknown;
  display?: unknown;
  swatches?: unknown;
}

/** The state an editor opens with, from the product's stored attributes. */
export function swatchStateFrom(attributes: readonly AttributeLike[] | null | undefined): SwatchFormState {
  const out: SwatchFormState = {};
  for (const a of attributes ?? []) {
    if (!a || typeof a.name !== 'string') continue;
    const swatches: Record<string, SwatchInput> = {};
    if (a.swatches && typeof a.swatches === 'object' && !Array.isArray(a.swatches)) {
      for (const [value, raw] of Object.entries(a.swatches as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const entry: SwatchInput = {};
        if (typeof r.color === 'string' && r.color) entry.color = r.color;
        if (typeof r.image === 'string' && r.image) entry.image = r.image;
        if (entry.color || entry.image) swatches[value] = entry;
      }
    }
    out[a.name] = { swatch: a.display === 'swatch', visible: a.visible !== false, swatches };
  }
  return out;
}

/** The meta for one attribute, created empty when the merchant adds it in the text. */
export function metaFor(state: SwatchFormState, name: string): AttributeMeta {
  state[name] ??= { swatch: false, visible: true, swatches: {} };
  return state[name];
}

/**
 * The attributes to save: what the text parsed to, with each one's swatch
 * state put back. A swatch for a value no longer in the text is not sent, and
 * a blank colour or image is not sent either (clearing a field clears it).
 */
export function applySwatchState<T extends { name: string; values: string[] }>(
  attributes: readonly T[],
  state: SwatchFormState,
): (T & { visible: boolean; display?: 'swatch'; swatches?: Record<string, SwatchInput> })[] {
  return attributes.map((a) => {
    const meta = state[a.name];
    const out: T & { visible: boolean; display?: 'swatch'; swatches?: Record<string, SwatchInput> } = {
      ...a,
      visible: meta ? meta.visible : true,
    };
    if (!meta) return out;
    if (meta.swatch) out.display = 'swatch';
    const swatches: Record<string, SwatchInput> = {};
    for (const value of a.values) {
      const s = meta.swatches[value];
      if (!s) continue;
      const color = typeof s.color === 'string' ? s.color.trim() : '';
      const image = typeof s.image === 'string' ? s.image.trim() : '';
      if (!color && !image) continue;
      swatches[value] = { ...(color ? { color } : {}), ...(image ? { image } : {}) };
    }
    if (Object.keys(swatches).length) out.swatches = swatches;
    return out;
  });
}

/** `#rgb` or `#rrggbb` as `#rrggbb` for an <input type="color">, else null. */
export function colorInputValue(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const hex = m[1].toLowerCase();
  return '#' + (hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex);
}
