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
    colors: {
      primary: '#3B82F6',
      secondary: '#8B5CF6',
      accent: '#10B981',
      background: '#FFFFFF',
      text: '#1F2937',
    },
    typography: { headingFont: 'Inter', bodyFont: 'Inter', fontSize: '16px' },
  },
});
