/**
 * One-click theme presets.
 *
 * The customizer has ~30 knobs now. That is the right amount of power and the
 * wrong amount of work for someone who just wants their site to stop looking
 * like a default. A preset is a complete, coherent bundle — colours, type,
 * shape, density, and a matching dark palette — applied in a single click.
 *
 * These are the "more design related options" made usable: the knobs are for
 * people who want them, the presets are for everyone else. Each one is a
 * deliberate look, not a random palette; they exist so the first thing a new
 * operator does is see the site visibly become theirs.
 *
 * A preset is expressed in the FLAT customizer payload shape, so applying one
 * is the same POST /api/themes/update the manual controls make — one write
 * path, one validator, no second way for a value to reach the database.
 */

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  /** Two colours for the admin swatch. */
  swatch: [string, string];
  settings: Record<string, string>;
}

export const PRESETS: ThemePreset[] = [
  {
    id: 'clean',
    name: 'Clean',
    description: 'Crisp neutral base with a confident blue. The safe default.',
    swatch: ['#2563eb', '#f8fafc'],
    settings: {
      primaryColor: '#2563eb', secondaryColor: '#7c3aed', accentColor: '#059669',
      backgroundColor: '#ffffff', textColor: '#0f172a',
      surfaceColor: '#ffffff', mutedColor: '#64748b', borderColor: '#e2e8f0',
      headingFont: 'Inter', bodyFont: 'Inter', fontSize: '16px',
      typeScale: 'normal', headingWeight: 'bold',
      radius: 'md', density: 'normal', shadow: 'soft',
      containerWidth: 'normal', buttonStyle: 'solid', headerStyle: 'split',
      colorScheme: 'light',
    },
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Serif headlines, generous measure. For sites that are mostly writing.',
    swatch: ['#1a1a1a', '#faf8f5'],
    settings: {
      primaryColor: '#1a1a1a', secondaryColor: '#8b5a2b', accentColor: '#a3512b',
      backgroundColor: '#faf8f5', textColor: '#1f1d1a',
      surfaceColor: '#ffffff', mutedColor: '#6f6a63', borderColor: '#e3ddd4',
      headingFont: 'Playfair Display', bodyFont: 'Lato', fontSize: '18px',
      typeScale: 'spacious', headingWeight: 'semibold',
      radius: 'none', density: 'roomy', shadow: 'none',
      containerWidth: 'narrow', buttonStyle: 'outline', headerStyle: 'centered',
      colorScheme: 'light',
    },
  },
  {
    id: 'optical',
    name: 'Optical',
    description: 'Clinical, high-contrast and calm — built for eyewear and healthcare.',
    swatch: ['#0d6b6b', '#f4fbfb'],
    settings: {
      primaryColor: '#0d6b6b', secondaryColor: '#1e3a5f', accentColor: '#c2703d',
      backgroundColor: '#f4fbfb', textColor: '#12211f',
      surfaceColor: '#ffffff', mutedColor: '#5c7371', borderColor: '#d3e6e4',
      headingFont: 'Montserrat', bodyFont: 'Open Sans', fontSize: '16px',
      typeScale: 'normal', headingWeight: 'semibold',
      radius: 'lg', density: 'normal', shadow: 'soft',
      containerWidth: 'normal', buttonStyle: 'pill', headerStyle: 'split',
      colorScheme: 'light',
    },
  },
  {
    id: 'boutique',
    name: 'Boutique',
    description: 'Warm, spacious and unhurried. Suits small catalogues and craft goods.',
    swatch: ['#8c5a3c', '#fdf9f4'],
    settings: {
      primaryColor: '#8c5a3c', secondaryColor: '#4a5d4e', accentColor: '#b8874f',
      backgroundColor: '#fdf9f4', textColor: '#2b2320',
      surfaceColor: '#ffffff', mutedColor: '#7d6a5d', borderColor: '#ece0d2',
      headingFont: 'Poppins', bodyFont: 'Nunito', fontSize: '17px',
      typeScale: 'spacious', headingWeight: 'medium',
      radius: 'lg', density: 'roomy', shadow: 'soft',
      containerWidth: 'normal', buttonStyle: 'soft', headerStyle: 'centered',
      colorScheme: 'light',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Dark by default, with a bright accent. Good for technical sites.',
    swatch: ['#5b9dff', '#0b0f16'],
    settings: {
      primaryColor: '#5b9dff', secondaryColor: '#a78bfa', accentColor: '#34d399',
      backgroundColor: '#0b0f16', textColor: '#e8eaed',
      surfaceColor: '#151b26', mutedColor: '#9aa4b2', borderColor: '#2a3242',
      headingFont: 'Inter', bodyFont: 'Inter', fontSize: '16px',
      typeScale: 'normal', headingWeight: 'semibold',
      radius: 'md', density: 'normal', shadow: 'strong',
      containerWidth: 'normal', buttonStyle: 'solid', headerStyle: 'split',
      colorScheme: 'dark',
    },
  },
  {
    id: 'bold',
    name: 'Bold',
    description: 'Heavy type, hard edges, strong contrast. Loud on purpose.',
    swatch: ['#e11d48', '#ffffff'],
    settings: {
      primaryColor: '#e11d48', secondaryColor: '#0f172a', accentColor: '#f59e0b',
      backgroundColor: '#ffffff', textColor: '#0a0a0a',
      surfaceColor: '#ffffff', mutedColor: '#525252', borderColor: '#171717',
      headingFont: 'Montserrat', bodyFont: 'Inter', fontSize: '16px',
      typeScale: 'spacious', headingWeight: 'bold',
      radius: 'none', density: 'compact', shadow: 'none',
      containerWidth: 'wide', buttonStyle: 'solid', headerStyle: 'minimal',
      colorScheme: 'light',
    },
  },
  {
    id: 'soft',
    name: 'Soft',
    description: 'Rounded, pastel and low-contrast. Friendly rather than corporate.',
    swatch: ['#7c6bd6', '#fbfaff'],
    settings: {
      primaryColor: '#7c6bd6', secondaryColor: '#e08db4', accentColor: '#4bb8a9',
      backgroundColor: '#fbfaff', textColor: '#33304a',
      surfaceColor: '#ffffff', mutedColor: '#7b7794', borderColor: '#e7e4f5',
      headingFont: 'Nunito', bodyFont: 'Nunito', fontSize: '17px',
      typeScale: 'normal', headingWeight: 'medium',
      radius: 'full', density: 'roomy', shadow: 'soft',
      containerWidth: 'normal', buttonStyle: 'pill', headerStyle: 'centered',
      colorScheme: 'auto',
    },
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'Monospace-leaning, dense, dark-first. For docs and dev tools.',
    swatch: ['#3ecf8e', '#101215'],
    settings: {
      primaryColor: '#3ecf8e', secondaryColor: '#6ba9ff', accentColor: '#f0b429',
      backgroundColor: '#101215', textColor: '#d8dee4',
      surfaceColor: '#181b1f', mutedColor: '#8b949e', borderColor: '#272c33',
      headingFont: 'Roboto', bodyFont: 'Roboto', fontSize: '15px',
      typeScale: 'compact', headingWeight: 'semibold',
      radius: 'sm', density: 'compact', shadow: 'none',
      containerWidth: 'wide', buttonStyle: 'outline', headerStyle: 'minimal',
      colorScheme: 'dark',
    },
  },
];

export const getPreset = (id: string): ThemePreset | undefined =>
  PRESETS.find((p) => p.id === id);
