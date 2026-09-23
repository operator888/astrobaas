/**
 * A write refused because another record already holds that slug.
 *
 * Lives in its own module so both storage drivers can throw it without
 * importing each other — `localdb.ts` already imports the SQL driver, so
 * defining it in either one would be a cycle.
 *
 * It is thrown from INSIDE the write, which is the whole point: the service
 * layer also checks uniqueness (and that check is what produces a helpful
 * 400), but a read there followed by a write here is two awaits apart, and
 * concurrent renames all saw the slug free and all took it. Create solved the
 * same problem by moving the check into the lock; update refuses instead of
 * renaming, because on update the author typed the slug and silently changing
 * it is worse than saying no.
 */
export class SlugTakenError extends Error {
  constructor(public readonly slug: string) {
    super(`slug "${slug}" is already used by another post or page`);
    this.name = 'SlugTakenError';
  }
}

/** True for the error above, across module instances. */
export function isSlugTakenError(err: unknown): err is SlugTakenError {
  return err instanceof Error && err.name === 'SlugTakenError';
}
