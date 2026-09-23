/**
 * Putting HTML into the rich-text editor — the one implementation.
 *
 * ## Why this file exists
 *
 * `SectionInserter.astro` carried this twice, once for sections and once for
 * patterns, byte-for-byte. The media picker is the third caller, and the
 * obvious move would have made it a third copy.
 *
 * ## The two things that are easy to get wrong
 *
 * **The textarea is what saves.** The contenteditable is what the author sees;
 * a hidden `<textarea>` beside it is what the form posts. Inserting into the
 * surface without syncing produces the worst possible outcome — the change is
 * visible, the author carries on, and it is gone after save.
 *
 * **Where the caret is decides where the HTML goes.** If the author clicked the
 * palette or the media grid first, the selection is no longer inside the editor
 * — it might be in another field entirely. `execCommand('insertHTML')` would put
 * the section wherever focus last was. So the caret is checked against the
 * surface, and anything outside it appends instead.
 */

/** The minimum an editor surface has to look like. Kept structural so this stays testable. */
export interface EditorSurface {
  innerHTML: string;
  focus(): void;
  contains(node: unknown): boolean;
  insertAdjacentHTML(position: string, html: string): void;
  closest(selector: string): { querySelector(sel: string): { value: string } | null } | null;
  dispatchEvent(event: unknown): boolean;
}

/**
 * Push the surface's html into the hidden textarea and announce the change.
 *
 * The `input` event is not decoration: autosave, the content-analysis panel and
 * the section toolbar all listen for it. An insert that skips it leaves the
 * green dot describing the document as it was two paragraphs ago.
 */
export function syncEditorSurface(surface: EditorSurface): void {
  const ta = surface.closest('.rich-text-editor')?.querySelector('textarea');
  if (ta) ta.value = surface.innerHTML;
  // Constructed here rather than passed in, so a caller cannot forget the
  // `bubbles` that makes the form-level listeners fire.
  surface.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Load stored html INTO the editor — the reverse of `syncEditorSurface`.
 *
 * A form that edits an existing record sets the hidden `<textarea>` and is done
 * when the field is a plain textarea. With the rich editor the textarea is only
 * the wire format: the thing a person sees and types into is the contenteditable
 * surface, which reads the textarea ONCE at construction. So a page that loads a
 * record after the editor has initialised — every "edit this product" screen —
 * sets a value nobody can see and then saves the empty surface over it.
 *
 * Both directions live here so the pair cannot drift: one function writes the
 * surface into the textarea, this one writes the textarea into the surface.
 */
export function loadEditorSurface(textarea: HTMLTextAreaElement | null | undefined, html: string): void {
  if (!textarea) return;
  textarea.value = html ?? '';
  const surface = textarea.closest('.rich-text-editor')?.querySelector('.editor-content');
  if (surface) (surface as HTMLElement).innerHTML = html ?? '';
}

/**
 * Insert html at the caret when the caret is genuinely in the editor, else append.
 *
 * `selectionIsInside` is injected rather than read from `window`, because that
 * is the only part that needs a DOM — and injecting it is what lets the rule
 * above be tested without one.
 */
export function insertIntoEditor(
  surface: EditorSurface,
  html: string,
  opts: {
    selectionIsInside?: () => boolean;
    execInsert?: (html: string) => void;
  } = {},
): void {
  if (!html) return;
  surface.focus();
  const inside = opts.selectionIsInside ? opts.selectionIsInside() : defaultSelectionIsInside(surface);
  if (inside && opts.execInsert) opts.execInsert(html);
  else if (inside && typeof document !== 'undefined') document.execCommand('insertHTML', false, html);
  else surface.insertAdjacentHTML('beforeend', html);
  syncEditorSurface(surface);
}

function defaultSelectionIsInside(surface: EditorSurface): boolean {
  if (typeof window === 'undefined' || !window.getSelection) return false;
  const sel = window.getSelection();
  return !!sel && sel.rangeCount > 0 && surface.contains(sel.getRangeAt(0).startContainer);
}
