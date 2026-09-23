/**
 * The design-token vocabulary: the whole surface a theme can change.
 *
 * ## Why enums resolve through a lookup table
 *
 * Free-form values (a colour, a font family) are cleaned with a DENYLIST — strip
 * the characters that could break out of a `--var: value;` declaration. That is
 * the right tool for a value the operator genuinely authors, and it is what
 * /theme.css has always done.
 *
 * Everything in this file is different: `radius`, `density`, `shadow`,
 * `containerWidth`, `buttonStyle`, `headerStyle` and the typography scale are
 * ENUMS. The stored value is a key like `"lg"`, and the CSS it selects is
 * written here, in source. A stored value can therefore never *be* CSS — only
 * *select* CSS. That is strictly stronger than sanitising, because there is no
 * sanitiser to get wrong: an unrecognised key falls back to the default and
 * emits nothing at all.
 *
 * It is also why adding a scale is cheap. The admin renders a <select> from
 * these keys; the CSS lives next to it; nothing in between has to be trusted.
 *
 * ## Why the values are pre-authored rather than computed
 *
 * A spacing scale that multiplies a base by a ratio produces `0.9375rem` and
 * similar noise. These are hand-picked so a "compact" site looks deliberately
 * compact rather than arithmetically smaller.
 */

/** A token group: allowed keys → the CSS custom properties each key emits. */
type Scale<K extends string> = Record<K, Record<string, string>>;

export type RadiusKey = 'none' | 'sm' | 'md' | 'lg' | 'full';
export const RADIUS: Scale<RadiusKey> = {
  none: { '--radius-sm': '0', '--radius-md': '0', '--radius-lg': '0', '--radius-pill': '0' },
  sm: { '--radius-sm': '2px', '--radius-md': '4px', '--radius-lg': '6px', '--radius-pill': '4px' },
  md: { '--radius-sm': '4px', '--radius-md': '8px', '--radius-lg': '12px', '--radius-pill': '9999px' },
  lg: { '--radius-sm': '8px', '--radius-md': '14px', '--radius-lg': '22px', '--radius-pill': '9999px' },
  // "full" means fully-round PILLS, not oval cards. Setting --radius-md and
  // --radius-lg to 9999px turned every container into an ellipse — a stat card
  // became a lozenge and a data table was clipped into a circle, because
  // global.css maps .rounded-lg/.rounded-xl onto these. Containers get a
  // generous radius; only --radius-pill is actually unbounded.
  full: { '--radius-sm': '10px', '--radius-md': '18px', '--radius-lg': '28px', '--radius-pill': '9999px' },
};

export type DensityKey = 'compact' | 'normal' | 'roomy';
export const DENSITY: Scale<DensityKey> = {
  compact: {
    '--space-1': '0.2rem', '--space-2': '0.4rem', '--space-3': '0.7rem',
    '--space-4': '1rem', '--space-6': '1.5rem', '--space-8': '2rem',
    '--section-y': '2.5rem',
  },
  normal: {
    '--space-1': '0.25rem', '--space-2': '0.5rem', '--space-3': '1rem',
    '--space-4': '1.5rem', '--space-6': '2.25rem', '--space-8': '3rem',
    '--section-y': '4rem',
  },
  roomy: {
    '--space-1': '0.35rem', '--space-2': '0.7rem', '--space-3': '1.4rem',
    '--space-4': '2rem', '--space-6': '3rem', '--space-8': '4.5rem',
    '--section-y': '6rem',
  },
};

export type ShadowKey = 'none' | 'soft' | 'strong';
export const SHADOW: Scale<ShadowKey> = {
  none: { '--shadow-sm': 'none', '--shadow-md': 'none', '--shadow-lg': 'none' },
  soft: {
    '--shadow-sm': '0 1px 2px rgb(0 0 0 / 0.04)',
    '--shadow-md': '0 2px 8px rgb(0 0 0 / 0.06)',
    '--shadow-lg': '0 8px 24px rgb(0 0 0 / 0.08)',
  },
  strong: {
    '--shadow-sm': '0 1px 3px rgb(0 0 0 / 0.12)',
    '--shadow-md': '0 4px 14px rgb(0 0 0 / 0.16)',
    '--shadow-lg': '0 18px 40px rgb(0 0 0 / 0.22)',
  },
};

export type ContainerKey = 'narrow' | 'normal' | 'wide' | 'full';
export const CONTAINER: Scale<ContainerKey> = {
  narrow: { '--container': '48rem', '--measure': '34rem' },
  normal: { '--container': '72rem', '--measure': '42rem' },
  wide: { '--container': '90rem', '--measure': '48rem' },
  full: { '--container': '100%', '--measure': '52rem' },
};

/** Type scale: the ratio between heading levels, plus body rhythm. */
export type TypeScaleKey = 'compact' | 'normal' | 'spacious';
export const TYPE_SCALE: Scale<TypeScaleKey> = {
  compact: {
    '--h1': '1.9rem', '--h2': '1.5rem', '--h3': '1.25rem',
    '--line-height': '1.5', '--heading-line-height': '1.2',
  },
  normal: {
    '--h1': '2.5rem', '--h2': '1.85rem', '--h3': '1.4rem',
    '--line-height': '1.65', '--heading-line-height': '1.2',
  },
  spacious: {
    '--h1': '3.25rem', '--h2': '2.25rem', '--h3': '1.6rem',
    '--line-height': '1.8', '--heading-line-height': '1.15',
  },
};

export type HeadingWeightKey = 'normal' | 'medium' | 'semibold' | 'bold';
export const HEADING_WEIGHT: Scale<HeadingWeightKey> = {
  normal: { '--heading-weight': '400' },
  medium: { '--heading-weight': '500' },
  semibold: { '--heading-weight': '600' },
  bold: { '--heading-weight': '700' },
};

/**
 * Button shape. Emitted as tokens rather than a class so a theme's own CSS and
 * a plugin's CSS both pick it up without coordinating on class names.
 */
export type ButtonStyleKey = 'solid' | 'outline' | 'soft' | 'pill';
export const BUTTON_STYLE: Scale<ButtonStyleKey> = {
  solid: {
    '--btn-bg': 'var(--primary-color)', '--btn-fg': 'var(--on-primary)',
    '--btn-border': 'transparent', '--btn-radius': 'var(--radius-md)',
  },
  outline: {
    '--btn-bg': 'transparent', '--btn-fg': 'var(--primary-color)',
    '--btn-border': 'var(--primary-color)', '--btn-radius': 'var(--radius-md)',
  },
  soft: {
    '--btn-bg': 'color-mix(in srgb, var(--primary-color) 12%, transparent)',
    '--btn-fg': 'var(--primary-color)',
    '--btn-border': 'transparent', '--btn-radius': 'var(--radius-md)',
  },
  pill: {
    '--btn-bg': 'var(--primary-color)', '--btn-fg': 'var(--on-primary)',
    '--btn-border': 'transparent', '--btn-radius': 'var(--radius-pill)',
  },
};

/**
 * Header layout.
 *
 * A `layout.headerStyle` field existed once and was DELETED by migration v3
 * because nothing consumed it — config that implies a capability it does not
 * have is worse than no config. It only returns here because the default
 * header actually reads these tokens now.
 */
export type HeaderStyleKey = 'minimal' | 'centered' | 'split' | 'masthead';
export const HEADER_STYLE: Scale<HeaderStyleKey> = {
  minimal: { '--header-align': 'flex-start', '--header-direction': 'row', '--header-pad': 'var(--space-3)', '--header-border': '1px' },
  centered: { '--header-align': 'center', '--header-direction': 'column', '--header-pad': 'var(--space-4)', '--header-border': '1px' },
  split: { '--header-align': 'space-between', '--header-direction': 'row', '--header-pad': 'var(--space-3)', '--header-border': '1px' },
  masthead: { '--header-align': 'center', '--header-direction': 'column', '--header-pad': 'var(--space-8)', '--header-border': '0px' },
};

export type ColorSchemeKey = 'light' | 'dark' | 'auto';

/** Every enum group, so the admin, the validator and the emitter share one list. */
export const TOKEN_SCALES = {
  radius: { keys: Object.keys(RADIUS) as RadiusKey[], map: RADIUS, default: 'md' as RadiusKey },
  density: { keys: Object.keys(DENSITY) as DensityKey[], map: DENSITY, default: 'normal' as DensityKey },
  shadow: { keys: Object.keys(SHADOW) as ShadowKey[], map: SHADOW, default: 'soft' as ShadowKey },
  containerWidth: { keys: Object.keys(CONTAINER) as ContainerKey[], map: CONTAINER, default: 'normal' as ContainerKey },
  typeScale: { keys: Object.keys(TYPE_SCALE) as TypeScaleKey[], map: TYPE_SCALE, default: 'normal' as TypeScaleKey },
  headingWeight: { keys: Object.keys(HEADING_WEIGHT) as HeadingWeightKey[], map: HEADING_WEIGHT, default: 'bold' as HeadingWeightKey },
  buttonStyle: { keys: Object.keys(BUTTON_STYLE) as ButtonStyleKey[], map: BUTTON_STYLE, default: 'solid' as ButtonStyleKey },
  headerStyle: { keys: Object.keys(HEADER_STYLE) as HeaderStyleKey[], map: HEADER_STYLE, default: 'split' as HeaderStyleKey },
} as const;

export type TokenScaleName = keyof typeof TOKEN_SCALES;
export const TOKEN_SCALE_NAMES = Object.keys(TOKEN_SCALES) as TokenScaleName[];

/**
 * Resolve one enum to its declarations.
 *
 * An unknown key is not an error and is never emitted: it falls back to the
 * group's default. A value that reached the DB by some other route (a hand
 * edit, an older build, a hostile write) can select a different look and
 * nothing else.
 */
export function resolveScale(name: TokenScaleName, value: unknown): Record<string, string> {
  const group = TOKEN_SCALES[name];
  const key = typeof value === 'string' && (group.keys as readonly string[]).includes(value)
    ? value
    : group.default;
  return (group.map as Record<string, Record<string, string>>)[key];
}

/* ------------------------------------------------------------------ */
/* Dark mode                                                           */
/* ------------------------------------------------------------------ */

/** #rrggbb → [r,g,b]; null for anything that is not a plain 6-digit hex. */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * Relative luminance (WCAG). Used to decide what colour text on the primary
 * should be, so a light brand colour does not get white text on it.
 */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Black or white, whichever stays readable on the given background. */
export function readableOn(hex: string): string {
  return luminance(hex) > 0.45 ? '#111827' : '#ffffff';
}

function mix(hex: string, target: [number, number, number], amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return toHex(
    rgb[0] + (target[0] - rgb[0]) * amount,
    rgb[1] + (target[1] - rgb[1]) * amount,
    rgb[2] + (target[2] - rgb[2]) * amount,
  );
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

/**
 * Derive a dark palette from the light one.
 *
 * A theme may author its own dark colours; when it has not, this is what runs.
 * It is deliberately conservative — surfaces become near-black, text becomes
 * near-white, and brand colours are lifted toward white just enough to stay
 * legible on a dark surface rather than being recomputed into something the
 * operator never chose. The point is "recognisably the same site at night",
 * not an automatic redesign.
 */
export function deriveDarkPalette(light: {
  primary: string; secondary: string; accent: string; background: string; text: string;
}): Record<string, string> {
  // Every output must be a literal hex. `mix()` returns its input untouched
  // when it cannot parse one, so without this guard a value like "red; }"
  // would pass straight through into a stylesheet. /theme.css does run `safe()`
  // first, but a function that emits CSS should not depend on its caller having
  // sanitised — this is the last line before the declaration is written.
  const hexOr = (c: unknown, fallback: string) =>
    typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : fallback;

  const lift = (raw: unknown, fallback: string) => {
    const c = hexOr(raw, fallback);
    return luminance(c) < 0.22 ? mix(c, WHITE, 0.42) : c;
  };
  const primary = lift(light.primary, '#60a5fa');
  return {
    '--primary-color': primary,
    '--secondary-color': lift(light.secondary, '#a78bfa'),
    '--accent-color': lift(light.accent, '#34d399'),
    '--background-color': '#0b0f16',
    '--surface-color': '#151b26',
    '--text-color': '#e8eaed',
    '--muted-color': '#9aa4b2',
    '--border-color': '#2a3242',
    '--on-primary': readableOn(primary),
  };
}

/** Is `value` a key this scale actually defines? Used by the write path. */
export function isTokenKey(name: TokenScaleName, value: string): boolean {
  return (TOKEN_SCALES[name].keys as readonly string[]).includes(value);
}
