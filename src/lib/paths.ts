/**
 * Resolves on-disk locations for mutable state. Both default to in-repo paths
 * for zero-config dev; override in production (e.g. Docker) to point at a
 * mounted volume so data survives redeploys.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Path to the lowdb JSON file. Override with the DB_PATH env var. */
export function getDbPath(): string {
  return process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.resolve(process.cwd(), 'db.json');
}

/**
 * Directory uploaded media is written to and served from. Override with the
 * UPLOADS_DIR env var. Defaults to `public/uploads` so dev serves files via
 * Astro's static handler; in a standalone production build the dedicated
 * `/uploads/[...path]` route serves them from this directory at runtime.
 */
export function getUploadsDir(): string {
  return process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.resolve(process.cwd(), 'public', 'uploads');
}

/**
 * Where a STRANGER'S uploaded file goes (C-23).
 *
 * Deliberately NOT under `getUploadsDir()`, and the difference is the whole
 * point of the directory existing.
 *
 * `public/uploads` is served by Astro's static handler in dev and by a reverse
 * proxy in most production deployments; the `/uploads/[...path]` route only
 * gets a look in a standalone Node build. So a file written there is world
 * readable at its URL whatever the record's read policy says — and a content
 * type marked `visibility: 'staff'` collecting CVs, prescriptions or ID scans
 * would be publishing them while its own settings screen said "staff only".
 *
 * Files here are reachable only through an authenticated route, because no
 * static handler is told about this directory at all.
 *
 * Override with PRIVATE_UPLOADS_DIR. Otherwise it is `private-uploads/` beside
 * the database (see `databaseDir()`), so a deployment that puts its database on
 * a volume gets these files on the same volume.
 *
 * ## Why the default moved
 *
 * This comment always said "a sibling of the database"; the code said
 * `cwd/private-uploads`. On every production layout this project ships, those
 * are different places, and the code's was the wrong one:
 *
 *  - under the reference systemd unit the working directory is the RELEASE,
 *    which `ProtectSystem=strict` makes read-only (every public-form upload
 *    failed with EROFS) and which the next deploy replaces anyway;
 *  - in the Docker image it is `/app`, outside the `/app/data` volume, so the
 *    files vanished whenever the container was recreated.
 *
 * With no DB_PATH and no DATABASE_URL — plain `npm run dev` — the database is
 * `cwd/db.json`, so the directory is still `cwd/private-uploads` and nothing
 * moves.
 *
 * ## Existing installs
 *
 * An install that has already stored files at the old location keeps using it
 * (see `resolvePrivateUploadsDir`) and logs how to move them. Silently
 * switching would make every stored attachment 404 in the admin while the
 * files sat one directory over.
 */
export function getPrivateUploadsDir(): string {
  return resolvePrivateUploadsDir(process.env, process.cwd()).dir;
}

/**
 * The directory the database lives in, for things that belong beside it.
 *
 * A `file:` DATABASE_URL names the SQLite file; that wins, because with
 * DATABASE_URL set DB_PATH is not used for anything. A remote libSQL URL has
 * no local directory, so DB_PATH's (if set) and then the working directory
 * stand in — which is why the reference unit and the Docker image set
 * PRIVATE_UPLOADS_DIR explicitly rather than relying on this.
 */
export function databaseDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const url = env.DATABASE_URL?.trim();
  if (url && /^file:/i.test(url)) {
    let rest = url.slice('file:'.length).split('?')[0]!;
    // file:///abs/x.db and file://localhost/abs/x.db are URLs; file:x.db and
    // file:/abs/x.db are the libSQL client's shorthand for a plain path.
    if (rest.startsWith('//')) {
      try {
        rest = decodeURIComponent(new URL(`file:${rest}`).pathname);
      } catch {
        rest = rest.replace(/^\/\/[^/]*/, '');
      }
    }
    if (rest) return path.dirname(path.resolve(cwd, rest));
  }
  const dbPath = env.DB_PATH ? path.resolve(cwd, env.DB_PATH) : path.resolve(cwd, 'db.json');
  return path.dirname(dbPath);
}

export interface PrivateUploadsResolution {
  dir: string;
  /** Why this directory: configured, the default, or the pre-move location. */
  source: 'env' | 'default' | 'legacy';
  /** Set when the operator should be told something. Logged once per process. */
  warning?: string;
}

/** A directory with at least one entry in it. Missing or unreadable is "no". */
function hasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Decided once per configuration and remembered, for two reasons: the
 * directory is asked for on every upload and every download, and the answer
 * must not flip mid-process — the first upload after boot creates the new
 * directory, and a check repeated after that would see files in BOTH places.
 */
const resolved = new Map<string, PrivateUploadsResolution>();
const warned = new Set<string>();

/** Testing seam: forget remembered decisions (and which warnings were logged). */
export function resetPrivateUploadsResolution(): void {
  resolved.clear();
  warned.clear();
}

/**
 * Which directory, and why.
 *
 *  - PRIVATE_UPLOADS_DIR set: that, always.
 *  - The old default (`cwd/private-uploads`) holds files and the new one does
 *    not: KEEP THE OLD ONE, and say how to move it. This is an install that
 *    has been storing attachments there, and its records point at them.
 *  - Both hold files: the new one, and say that the old one is stranded.
 *  - Otherwise: the new one.
 */
export function resolvePrivateUploadsDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): PrivateUploadsResolution {
  const configured = env.PRIVATE_UPLOADS_DIR?.trim();
  if (configured) return { dir: path.resolve(cwd, configured), source: 'env' };

  const fresh = path.join(databaseDir(env, cwd), 'private-uploads');
  const legacy = path.resolve(cwd, 'private-uploads');
  if (fresh === legacy) return { dir: fresh, source: 'default' };

  const key = `${fresh}\0${legacy}`;
  let out = resolved.get(key);
  if (!out) {
    const legacyHasFiles = hasEntries(legacy);
    const freshHasFiles = hasEntries(fresh);
    if (legacyHasFiles && !freshHasFiles) {
      out = {
        dir: legacy,
        source: 'legacy',
        warning:
          `[private-uploads] Using the OLD location ${legacy}, because it holds files and ${fresh} does not. `
          + 'The default moved beside the database so these files survive deploys and container rebuilds. '
          + `To move them: stop the app, run  mv ${legacy} ${fresh}  and start it again. `
          + `Or keep them where they are with PRIVATE_UPLOADS_DIR=${legacy}.`,
      };
    } else if (legacyHasFiles && freshHasFiles) {
      out = {
        dir: fresh,
        source: 'default',
        warning:
          `[private-uploads] Files exist in BOTH ${legacy} (the old default) and ${fresh} (the current one). `
          + `Using ${fresh}. Attachments stored under the old location will not be found until they are `
          + 'merged into it, or until PRIVATE_UPLOADS_DIR names the one you want.',
      };
    } else {
      out = { dir: fresh, source: 'default' };
    }
    resolved.set(key, out);
  }
  if (out.warning && !warned.has(key)) {
    warned.add(key);
    console.warn(out.warning);
  }
  return out;
}
