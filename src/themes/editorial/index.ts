import { defineTheme } from 'astrobaas/core';
import Header from './Header.astro';
import PostCard from './PostCard.astro';
import PostArticle from './PostArticle.astro';
import Footer from './Footer.astro';
import Home from './Home.astro';
import PageArticle from './PageArticle.astro';
import Breadcrumbs from './Breadcrumbs.astro';

/**
 * Editorial — the reference theme that overrides the WHOLE template surface.
 *
 * Six slots: masthead header, colophon footer, list-row cards, print-spread
 * articles, a front page whose hero is the newest article, and Pages in the
 * same serif register. Sidebar is deliberately inherited — a magazine spread
 * does not want one, and PublicLayout already omits it for contexts that ask.
 * Activating this theme should feel like changing publications, not palettes;
 * that is the bar every theme in this registry has to clear.
 */
export default defineTheme({
  id: 'editorial',
  name: 'Editorial',
  description: 'Typographic, masthead-led layout with a list-style article index.',
  version: '1.0.0',
  author: 'AstroBaaS Team',
  settings: {
    colors: {
      primary: '#111827',
      secondary: '#6B7280',
      accent: '#B45309',
      background: '#FFFFFF',
      text: '#111827',
    },
    typography: { headingFont: 'Playfair Display', bodyFont: 'Inter', fontSize: '17px' },
  },
  components: { Header, PostCard, PostArticle, Footer, Home, PageArticle, Breadcrumbs },
});
