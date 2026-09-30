/**
 * Applying planned per-product updates — shared by bulk edit, CSV update and
 * undo, so all three save the same way:
 *
 *  - through `saveProduct`, so validation, after-save hooks, `product.updated`
 *    webhooks, price history and the per-product audit line all happen;
 *  - with the stock the plan READ passed as bases, so a unit a checkout sells
 *    while the batch runs stays sold (tests/stock-race.test.mjs, D9);
 *  - recording each changed field's before and after value, so the batch can
 *    be undone (bulk-history.ts).
 *
 * Not a transaction — storage has none across rows. A product that fails is
 * reported with its reason and the rest still apply.
 */
import type { Product } from '../../core/models';
import { LocalDB } from '../localdb';
import { saveProduct } from '../commerce-service';
import { trackedFields, diffFields, patchedPaths, HISTORY_NS, HISTORY_KEEP, type BatchRecord } from './bulk-history';

/**
 * The largest undo record kept. Records live in storage that, on the JSON
 * driver, is rewritten on every write — twenty 30 MB records would make every
 * save in the shop slow. A batch too big to record is still APPLIED; it is
 * reported as not undoable instead of being recorded.
 */
export const MAX_RECORD_BYTES = 512 * 1024;

export interface PlannedUpdate {
  id: string;
  name: string;
  patch: Partial<Product>;
}

export interface ApplyResult {
  updated: number;
  failed: { id: string; name: string; message: string }[];
  /** The history record's id, or null when nothing changed or it was too large to record. */
  batch: string | null;
  /** True when the change was applied but is too large to keep for undo. */
  too_large_to_undo?: boolean;
}

export async function applyPlannedUpdates(
  plans: readonly PlannedUpdate[],
  read: ReadonlyMap<string, Product>,
  meta: { actor: string; kind: BatchRecord['kind']; label: string },
): Promise<ApplyResult> {
  const failed: ApplyResult['failed'] = [];
  const products: BatchRecord['products'] = {};
  let updated = 0;
  for (const plan of plans) {
    if (!Object.keys(plan.patch).length) continue;
    const before = read.get(plan.id);
    if (!before) { failed.push({ id: plan.id, name: plan.name, message: 'no longer exists' }); continue; }
    // The counts this plan READ, as bases: saveProduct leaves any count that
    // still equals its base untouched. Without them, a variants array built
    // from the plan's snapshot writes back stock a checkout sold meanwhile.
    const bases = {
      stock: before.stock ?? null,
      variants: new Map((before.variants ?? []).map((v) => [v.id, v.stock ?? null] as [string, number | null])),
    };
    const saved = await saveProduct(plan.patch, plan.id, meta.actor, bases);
    if (!saved.ok) { failed.push({ id: plan.id, name: plan.name, message: saved.message }); continue; }
    updated++;
    // Only the fields THIS patch set — see patchedPaths for why not everything.
    const changes = diffFields(trackedFields(before), trackedFields(saved.value), patchedPaths(plan.patch, before));
    if (changes.length) products[plan.id] = { name: plan.name, changes };
  }

  if (!Object.keys(products).length) return { updated, failed, batch: null };
  const id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const record: BatchRecord = { id, at: new Date().toISOString(), actor: meta.actor, kind: meta.kind, label: meta.label, products };
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) return { updated, failed, batch: null, too_large_to_undo: true };
  await LocalDB.putPluginData(HISTORY_NS, id, record as unknown as Record<string, unknown>);
  await pruneHistory();
  return { updated, failed, batch: id };
}

/** The recent batches, newest first. */
export async function recentBatches(): Promise<BatchRecord[]> {
  const rows = await LocalDB.getPluginData(HISTORY_NS);
  return rows
    .map((r) => r.data as unknown as BatchRecord)
    .filter((b) => b && typeof b.id === 'string')
    .sort((a, b) => b.at.localeCompare(a.at));
}

async function pruneHistory(): Promise<void> {
  const all = await recentBatches();
  for (const old of all.slice(HISTORY_KEEP)) await LocalDB.deletePluginDataRecord(HISTORY_NS, old.id);
}

/** Batches an undo is running for in THIS process — the in-process half of "undo once". */
const undoing = new Set<string>();

/**
 * Claim a batch for undoing: mark it undone BEFORE applying, so a second click
 * (or a second admin) is refused rather than running the same undo twice —
 * which could write back stock sold in between. Returns false when it is
 * already claimed. Across instances two claims can still race; the in-process
 * set closes the common case, a double click.
 */
export async function claimUndo(record: BatchRecord, actor: string): Promise<boolean> {
  if (undoing.has(record.id)) return false;
  undoing.add(record.id);
  const fresh = await LocalDB.getPluginDataRecord(HISTORY_NS, record.id);
  if (!fresh || (fresh.data as { undone_at?: string }).undone_at) { undoing.delete(record.id); return false; }
  await LocalDB.putPluginData(HISTORY_NS, record.id, { ...record, undone_at: new Date().toISOString(), undone_by: actor } as unknown as Record<string, unknown>);
  return true;
}

/** Release a claim: after the undo ran, or — if every product failed — so it can be retried. */
export async function releaseUndo(record: BatchRecord, succeeded: boolean): Promise<void> {
  if (!succeeded) await LocalDB.putPluginData(HISTORY_NS, record.id, record as unknown as Record<string, unknown>);
  undoing.delete(record.id);
}
