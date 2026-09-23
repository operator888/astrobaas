/**
 * The REST client both binaries use.
 *
 * `astrobaas-mcp` had the only copy, and the CLI's new content verbs needed the
 * same three things it had already got right — the bearer header, the
 * `{success, data}` envelope unwrap, and the fact that a body carrying
 * `success: false` is an ERROR even when the status is 200. A second copy would
 * have got the third one wrong, because it is the one you only discover by
 * hitting it.
 *
 * Zero dependencies on purpose: these binaries run from `npx` on a machine that
 * may have nothing installed, and a client that needed a package would make the
 * install the first thing to go wrong.
 */

/** Where the site is. Overridden per invocation by --base. */
export function resolveBase(env = process.env) {
  return (env.ASTROBAAS_URL || env.ASTROBAAS_BASE || 'http://localhost:4321').replace(/\/+$/, '');
}

/** The API key, if the operator set one. */
export function resolveKey(env = process.env) {
  return env.ASTROBAAS_KEY || '';
}

/**
 * One request.
 *
 * Throws on a transport failure, on a non-2xx, and on a 200 whose envelope says
 * `success: false` — that last case is the one a hand-rolled client misses, and
 * it turns "the server refused" into "the command quietly did nothing".
 */
export async function apiRequest(method, path, body, opts = {}) {
  const base = opts.base ?? resolveBase();
  const key = opts.key ?? resolveKey();
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${base}${path}`, { method, headers, body: payload });
  } catch (err) {
    throw new Error(
      `Could not reach ${base} — ${err.message}\n`
      + '  Is the site running? Set ASTROBAAS_URL to point somewhere else.',
    );
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return text;
  }
  if (!res.ok || (json && json.success === false)) {
    const msg = json && json.success === false ? json.error?.message : `HTTP ${res.status}`;
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return json && json.success === true ? json.data : json;
}

/** The whole envelope, for a caller that needs `meta` (paging, totals). */
export async function apiEnvelope(method, path, body, opts = {}) {
  const base = opts.base ?? resolveBase();
  const key = opts.key ?? resolveKey();
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok || (json && json.success === false)) {
    throw new Error((json && json.error?.message) || `HTTP ${res.status}`);
  }
  return json ?? {};
}
