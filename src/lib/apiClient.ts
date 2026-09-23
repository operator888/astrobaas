/**
 * Browser-side API helper. Adds the CSRF header to every write request and
 * normalises the response into `{ ok, data, error }`. Tiny, no deps.
 *
 * Reusable outside this app: the CSRF source is configurable via
 * `configureApiClient({ getCsrfToken })`. By default it reads
 * `window.__ASTROBAAS__.csrf` then falls back to a `<meta name="csrf-token">`
 * tag — so it works in any project that exposes the token either way.
 */

declare global {
  interface Window {
    __ASTROBAAS__?: { csrf: string; user: { id: string; role: string } | null };
  }
}

export type ApiResult<T = any> =
  | { ok: true; status: number; data: T; meta?: any; message?: string }
  | {
      ok: false;
      status: number;
      error: string;
      details?: any;
      /**
       * Seconds to wait, when the server said so (a 429 carries it).
       *
       * Surfaced here because the browser hides `Retry-After` from JavaScript on
       * a cross-origin response unless it is explicitly exposed, and a caller
       * that cannot read it can only guess — which in practice means retrying
       * at once, from everything that was just throttled.
       */
      retryAfter?: number;
    };

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let csrfResolver: (() => string) | null = null;

/** Override how the client obtains the CSRF token (for use outside this app). */
export function configureApiClient(opts: { getCsrfToken?: () => string }): void {
  if (opts.getCsrfToken) csrfResolver = opts.getCsrfToken;
}

function getCsrf(): string {
  if (csrfResolver) return csrfResolver();
  if (typeof window === 'undefined') return '';
  const fromWindow = window.__ASTROBAAS__?.csrf;
  if (fromWindow) return fromWindow;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]');
  return meta?.content ?? '';
}

export interface ApiFetchOptions extends RequestInit {
  json?: any;
  query?: Record<string, string | number | boolean | undefined | null>;
}

export async function apiFetch<T = any>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<ApiResult<T>> {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = new Headers(opts.headers ?? {});

  let body = opts.body;
  if (opts.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(opts.json);
  }

  if (WRITE_METHODS.has(method)) {
    const token = getCsrf();
    if (token) headers.set('X-CSRF-Token', token);
  }

  let url = path;
  if (opts.query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null || v === '') continue;
      sp.set(k, String(v));
    }
    const q = sp.toString();
    if (q) url += (url.includes('?') ? '&' : '?') + q;
  }

  let res: Response;
  try {
    res = await fetch(url, { ...opts, method, headers, body, credentials: 'same-origin' });
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message || 'Network error' };
  }

  // 204 no-content
  if (res.status === 204) {
    return { ok: true, status: res.status, data: null as any };
  }

  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON response.
      if (res.ok) return { ok: true, status: res.status, data: text as any };
      return { ok: false, status: res.status, error: text || res.statusText };
    }
  }

  if (parsed && parsed.success === true) {
    return {
      ok: true,
      status: res.status,
      data: parsed.data,
      meta: parsed.meta,
      message: parsed.message,
    };
  }
  if (parsed && parsed.success === false) {
    return {
      ok: false,
      status: res.status,
      error: parsed.error?.message ?? 'Request failed',
      details: parsed.error?.details,
      ...(Number.isFinite(Number(parsed.error?.retry_after))
        ? { retryAfter: Number(parsed.error.retry_after) }
        : {}),
    };
  }
  // Every endpoint returns the ApiResponseBuilder shape above; anything else is
  // unexpected. Fall back to HTTP status so callers still get a sane result.
  if (res.ok) return { ok: true, status: res.status, data: parsed as T };
  return { ok: false, status: res.status, error: res.statusText || 'Request failed' };
}

/** Convenience helpers. */
export const api = {
  get: <T = any>(path: string, query?: ApiFetchOptions['query']) =>
    apiFetch<T>(path, { query }),
  post: <T = any>(path: string, json?: any) => apiFetch<T>(path, { method: 'POST', json }),
  put: <T = any>(path: string, json?: any) => apiFetch<T>(path, { method: 'PUT', json }),
  patch: <T = any>(path: string, json?: any) => apiFetch<T>(path, { method: 'PATCH', json }),
  delete: <T = any>(path: string, json?: any) => apiFetch<T>(path, { method: 'DELETE', json }),
};
