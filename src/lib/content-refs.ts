/**
 * Relations and media handles on custom content types.
 *
 * `validate()` says whether a value LOOKS like an id. Whether the thing it
 * names exists is a different question, and answering it needs a database, so
 * it lives here rather than in the validator — which stays pure and testable.
 *
 * Both halves are in one module because both are asked from more than one
 * place: create and update must agree about what a valid reference is, and the
 * list and single-entity reads must agree about how a media handle becomes a
 * URL. Two copies of either is the sibling gap this codebase keeps finding.
 */
import { LocalDB } from './localdb';
import { getContentType } from '../core/content-types';
import type { ContentTypeDefinition } from '../core/content-types';
import { fieldsOfType, valuesAt, setAt } from './field-walk';
import { readPrivateFileMeta } from './media/private-files';

/**
 * Field name → the collection it points at, for every `ref` on a type.
 *
 * TOP LEVEL only, kept for callers that address a field by its own name. The
 * nested ones are reached through `fieldsOfType`, which is what
 * `checkReferences` and `resolveMediaUrls` below actually use — a `ref` inside
 * a repeater item is still a reference, and one that resolved to nothing while
 * the check said it was fine is the "accept it, resolve to nothing on read"
 * failure this module's own docblock refuses.
 */
export function refFields(def: ContentTypeDefinition): { name: string; to: string }[] {
  return def.fields
    .filter((f) => f.rule.type === 'ref')
    .map((f) => ({ name: f.name, to: (f.rule as { to: string }).to }));
}

/** Every top-level `media` field on a type. See the note on {@link refFields}. */
export function mediaFields(def: ContentTypeDefinition): string[] {
  return def.fields.filter((f) => f.rule.type === 'media').map((f) => f.name);
}

/**
 * Do the things this record points at actually exist?
 *
 * Returns field-keyed errors in the shape `validate()` uses, so a route can
 * merge them into the same 422 without inventing a second error format.
 *
 * Only fields PRESENT in the value are checked: on an update the body is
 * partial, and a reference nobody touched is not this write's problem.
 *
 * A dangling reference is refused rather than stored and tidied later. The
 * alternative — accept it, resolve to nothing on read — is how a site ends up
 * with events whose venue is blank and no record of when it stopped being
 * true.
 */
export async function checkReferences(
  def: ContentTypeDefinition,
  value: Record<string, unknown>,
): Promise<Record<string, string> | null> {
  const errors: Record<string, string> = {};

  // Nested ones included: a `ref` inside a repeater item points at a record
  // exactly as a top-level one does, and a check that could not see it would
  // let a dangling reference through the door the flat check guards.
  for (const walked of fieldsOfType(def, 'ref')) {
    const name = walked.path;
    const to = (walked.field.rule as { to: string }).to;
    for (const id of valuesAt(walked, value)) {
    if (typeof id !== 'string' || id === '') continue;
    // A ref whose TARGET TYPE is no longer registered — the collection was
    // deleted — can never resolve for any reader, even though its entries
    // linger unserved in storage. Refuse it rather than validate against rows
    // nothing can reach. A required ref then blocks the write, which is the
    // honest outcome: the thing it must point at is gone.
    if (!getContentType(to)) {
      errors[name] = `${name} points at the collection "${to}", which no longer exists`;
      continue;
    }
    const target = await LocalDB.getCustomEntity(to, id);
    if (!target) errors[name] = `${name} points at a ${to} that does not exist`;
    }
  }

  const media = fieldsOfType(def, 'media');
  if (media.length > 0) {
    // One read for all of them: a type with four image fields should not cost
    // four passes over the media library.
    const library = await LocalDB.getMedia();
    const known = new Set((library as { id: string }[]).map((m) => m.id));
    for (const walked of media) {
      for (const id of valuesAt(walked, value)) {
        if (typeof id !== 'string' || id === '') continue;
        if (!known.has(id)) errors[walked.path] = `${walked.path} points at a file that is not in the media library`;
      }
    }
  }

  // A file a stranger uploaded (C-23). Checked like a ref: a record pointing
  // at bytes that are not there resolves to a broken download for a member of
  // staff who has no way to tell whether the applicant sent one.
  for (const walked of fieldsOfType(def, 'file')) {
    for (const id of valuesAt(walked, value)) {
      if (typeof id !== 'string' || id === '') continue;
      if (!(await readPrivateFileMeta(id))) {
        errors[walked.path] = `${walked.path} points at an upload that is not there`;
      }
    }
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Add the resolved URLs a reader needs, without changing what is stored.
 *
 * A media field stores an ID, because a URL baked into a record is wrong the
 * day the site moves domain or the file is replaced. But every consumer wants
 * a URL, and making each of them fetch the media library separately is how a
 * list of twenty entries becomes twenty-one requests.
 *
 * So the stored value is untouched and a sibling `<field>_url` is added on the
 * way out. `_url` rather than replacing the id: a client that wants to render
 * the picture and a client that wants to re-save the record both get what they
 * need, and a round-trip through an editor cannot turn an id into a URL.
 */
export async function resolveMediaUrls<T extends { data?: Record<string, unknown> }>(
  def: ContentTypeDefinition,
  entities: T[],
): Promise<T[]> {
  const fields = fieldsOfType(def, 'media');
  if (fields.length === 0 || entities.length === 0) return entities;

  const library = (await LocalDB.getMedia()) as { id: string; url?: string; alt_text?: string }[];
  const byId = new Map(library.map((m) => [m.id, m]));

  /** The sibling keys one media id contributes. Same rule at both levels. */
  const siblings = (name: string, id: unknown): Record<string, unknown> | undefined => {
    if (typeof id !== 'string' || !id) return undefined;
    const file = byId.get(id);
    // A handle whose file has since been deleted resolves to nothing rather
    // than to a broken URL — and the id stays, so it is still visible in the
    // admin that something used to be there.
    if (!file?.url) return undefined;
    const out: Record<string, unknown> = { [`${name}_url`]: file.url };
    if (file.alt_text) out[`${name}_alt`] = file.alt_text;
    return out;
  };

  return entities.map((e) => {
    if (!e.data) return e;
    // Deep-copied before mutation: setAt writes into repeater ITEMS, and those
    // are objects a caller may still be holding. A shallow spread would hand
    // back a "copy" whose nested items are the originals, enriched in place.
    const data = structuredClone(e.data) as Record<string, unknown>;
    let touched = false;
    for (const walked of fields) {
      setAt(walked, data, (id) => {
        const extra = siblings(walked.field.name, id);
        if (extra) touched = true;
        return extra;
      });
    }
    return touched ? { ...e, data } : e;
  });
}
