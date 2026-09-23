import { defineTheme } from 'astrobaas/core';
import Header from './Header.astro';
import Footer from './Footer.astro';
import PostCard from './PostCard.astro';
import PostArticle from './PostArticle.astro';
import Home from './Home.astro';
import PageArticle from './PageArticle.astro';
import Breadcrumbs from './Breadcrumbs.astro';

/**
 * Marquee — the poster theme, and the registry's proof of range.
 *
 * Default is a clean SaaS look; Editorial is a serif magazine; this is a
 * street poster: display caps, four-pixel rules, stamped tiles, one loud
 * accent. If activating a theme is supposed to feel like changing sites
 * entirely, the registry needs at least one member this far from the others.
 *
 * Everything colour-shaped comes from the token system, so the customizer can
 * still recolour it — a poster in different ink is still a poster.
 */
export default defineTheme({
  id: 'marquee',
  name: 'Marquee',
  description: 'Poster-style: display caps, thick rules, stamped tiles, one loud accent.',
  version: '1.0.0',
  author: 'AstroBaaS Team',
  settings: {
    colors: {
      primary: '#16130d',
      secondary: '#5c564a',
      accent: '#e2442f',
      background: '#f4efe4',
      text: '#16130d',
      surface: '#faf7ef',
      muted: '#6b6455',
      border: '#16130d',
    },
    typography: {
      headingFont: 'Archivo Black',
      bodyFont: 'Archivo',
      fontSize: '17px',
      scale: 'bold',
      headingWeight: 'bold',
    },
    style: {
      radius: 'none',
      density: 'normal',
      shadow: 'none',
      containerWidth: 'normal',
      buttonStyle: 'solid',
      headerStyle: 'masthead',
    },
  },
  components: { Header, Footer, PostCard, PostArticle, Home, PageArticle, Breadcrumbs },
});
