import type { APIRoute } from 'astro';
import { metricsEnabled, renderMetrics } from '../lib/observability';

// Prometheus metrics — DISABLED by default (404). Set METRICS_ENABLED=1 to
// expose request/error counters + uptime. Keep it behind your network policy or
// a scrape allowlist; it's intentionally unauthenticated so a scraper can read
// it, but it exposes no content or secrets.
export const prerender = false;

export const GET: APIRoute = async () => {
  if (!metricsEnabled()) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(renderMetrics(), {
    status: 200,
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' },
  });
};
