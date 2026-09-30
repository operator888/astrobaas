import { defineTheme } from 'astrobaas/core';

/**
 * The stock theme. Overrides nothing — every slot uses the built-in default
 * component, so this is exactly the site you get out of the box. It exists as a
 * real theme module so "default" is a first-class entry in the registry rather
 * than a special case in the resolver.
 *
 * Its `settings` are the seed tokens; an operator's customizer changes are
 * stored on the DB record and take precedence.
 */
export default defineTheme({
  id: 'default',
  name: 'AstroBaaS Default',
  description: 'Clean and modern default theme for AstroBaaS.',
  version: '1.0.0',
  author: 'AstroBaaS Team',
  settings: {
    // WCAG 2.1 AA with white text on them, and as text on white: 5.17, 5.70
    // and 5.48 to 1. The previous blue-500/violet-500/emerald-500 were 3.67,
    // 4.23 and 2.53 — every primary button on a fresh install failed.
    colors: {
      primary: '#2563EB',
      secondary: '#7C3AED',
      accent: '#047857',
      background: '#FFFFFF',
      text: '#1F2937',
    },
    typography: { headingFont: 'Inter', bodyFont: 'Inter', fontSize: '16px' },
  },
});
