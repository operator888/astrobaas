/**
 * Scheduled-post worker: flips `status: 'scheduled'` posts to `published` once
 * their `publish_date` has passed. Runs as an in-process interval on this
 * long-lived Node server (plus an immediate sweep at startup). Disable with
 * SCHEDULER_DISABLED=1; tune the cadence with SCHEDULER_INTERVAL_MS.
 *
 * ## One sweeper per database, not one per process
 *
 * This comment used to say each replica sweeping independently was safe,
 * because publishing an already-published post is a no-op. The sweep grew:
 * it now sends newsletter batches, recovery reminders and back-in-stock
 * notices, cancels abandoned orders and pushes off-site backups — and with two
 * replicas every one of those happened twice.
 *
 * So a process sweeps only while it holds the `scheduler` lease
 * (src/lib/lease.ts). Every process still ticks; on each tick it tries to take
 * or renew the lease, and only the holder goes on to sweep. The others are
 * followers, and one of them takes over within about one lease TTL (three
 * intervals by default) if the leader dies — at its next tick if the leader
 * shut down cleanly, because a clean shutdown releases the lease.
 *
 * SCHEDULER_LEASE=0 turns that off (every process sweeps, as before).
 * startScheduler() is idempotent.
 */
import { LocalDB } from './localdb';
import { fireEvent } from './webhooks';
import {
  isPostDue,
  schedulerEnabled,
  schedulerIntervalMs,
  schedulerLeaseEnabled,
  schedulerLeaseTtlMs,
} from './scheduler-util';
import { flushViews } from './views';
import { Leadership, type LeadershipState } from './lease';
import { escapeHtml } from './escape-html';

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
/** Set by stopScheduler(): no NEW sweep starts, and a running one stops at its next check. */
let stopping = false;
/** The sweep in progress, so a shutdown can wait for it (awaitSchedulerSweep). */
let currentSweep: Promise<void> | null = null;
/** Null when the lease is switched off, or before start. */
let leadership: Leadership | null = null;
let sweepCount = 0;

/**
 * May a sweep that is already running go on to its next expensive step?
 *
 * No once a shutdown has begun — the drain is waiting for it — and no once
 * this process has stopped believing it holds the lease (a stall long enough
 * for somebody else to take over). Checked by the long, outward-facing steps
 * (the backup upload, the campaign batch), not between every line: the rest
 * are quick database passes.
 */
function sweepMayContinue(): boolean {
  if (stopping) return false;
  return leadership ? leadership.isLeader() : true;
}

/**
 * What the last sweep did.
 *
 * In memory, deliberately: this describes THIS process. On a restart it is
 * empty, and that is the honest answer — a persisted "last run" from a
 * previous process would tell an operator the scheduler is running when it may
 * not be. `startedAt` is the load-bearing field: an operator looking at a post
 * that should have gone live needs to know whether the worker is running here
 * at all.
 */
export interface SchedulerStatus {
  enabled: boolean;
  intervalMs: number;
  /** When this process started sweeping. Null when it never did. */
  startedAt: string | null;
  lastRunAt: string | null;
  lastPublished: number;
  lastCancelled: number;
  /** Customers reminded of an unpaid order on the last sweep. */
  lastReminded: number;
  /** Customers told a product is back, on the last sweep. */
  lastRestocked: number;
  /** Products whose sale window opened or closed on the last sweep. */
  lastRepriced: number;
  /** Set when the last sweep threw. */
  lastError: string | null;
  /**
   * What this process is doing about the `scheduler` lease.
   *
   *  - `leader`      it holds the lease and sweeps;
   *  - `follower`    another process holds it; this one stands by;
   *  - `standalone`  the lease is switched off (SCHEDULER_LEASE=0) — it sweeps
   *                  regardless of other processes;
   *  - `stopped`     stopScheduler() has run (a shutdown is under way);
   *  - null          it never started here.
   */
  role?: 'leader' | 'follower' | 'standalone' | 'stopped' | null;
  /** Sweeps this process has run since it started. */
  sweeps?: number;
  /** The lease as this process last saw it. Null when the lease is off. */
  lease?: LeadershipState | null;
}

let status: SchedulerStatus = {
  enabled: false,
  intervalMs: 0,
  startedAt: null,
  lastRunAt: null,
  lastPublished: 0,
  lastCancelled: 0,
  lastReminded: 0,
  lastRestocked: 0,
  lastRepriced: 0,
  lastError: null,
};

/** What the in-process scheduler has been doing. */
export function schedulerStatus(env: NodeJS.ProcessEnv = process.env): SchedulerStatus {
  return {
    ...status,
    // Read live rather than from the snapshot: an operator who has just
    // changed the environment and restarted wants to see what is configured
    // NOW, and `startedAt` already says whether it took effect.
    enabled: schedulerEnabled(env),
    intervalMs: schedulerIntervalMs(env),
    role: schedulerRole(),
    sweeps: sweepCount,
    lease: leadership ? leadership.snapshot() : null,
  };
}

function schedulerRole(): SchedulerStatus['role'] {
  if (!started) return null;
  if (stopping) return 'stopped';
  if (!leadership) return 'standalone';
  return leadership.isLeader() ? 'leader' : 'follower';
}

/** Publish every post whose schedule is due. Returns how many were published. */
export async function publishDuePosts(now: number = Date.now()): Promise<number> {
  // Storage-not-ready at boot is expected and transient — swallow it and try
  // next tick. A genuine failure (a write that keeps erroring) must NOT be
  // swallowed: it is the reason a scheduled post never appears, and the
  // operations screen has to see it. So a read failure returns 0 quietly, but
  // a persistent WRITE failure is counted and re-thrown so run()'s catch
  // records it as lastError.
  let posts;
  try {
    posts = await LocalDB.getPosts();
  } catch {
    return 0; // storage not ready — try again next tick
  }
  let count = 0;
  let failures = 0;
  let lastFailure: unknown = null;
  for (const p of posts) {
    if (isPostDue(p, now)) {
      try {
        const updated = await LocalDB.updatePost(p.id, { status: 'published' });
        if (updated) {
          count += 1;
          fireEvent('post.updated', updated).catch(() => {});
        }
      } catch (err) {
        failures += 1;
        lastFailure = err;
      }
    }
  }
  if (failures > 0) {
    throw new Error(
      `${failures} scheduled post(s) failed to publish: ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}`,
    );
  }
  return count;
}

/** Start the interval sweep once (idempotent; respects SCHEDULER_DISABLED). */
export function startScheduler(env: NodeJS.ProcessEnv = process.env): void {
  if (started || !schedulerEnabled(env)) return;
  started = true;
  status.startedAt = new Date().toISOString();
  leadership = schedulerLeaseEnabled(env)
    ? new Leadership({ name: 'scheduler', ttlMs: schedulerLeaseTtlMs(env) })
    : null;
  // One sweep at a time. setInterval fires whether or not the previous tick
  // finished, and a backup of a few hundred MB over a modest uplink takes far
  // longer than the 60s default interval — so without this, tick 2..N each
  // launched ANOTHER full backup (backupDue only flips false once one
  // COMPLETES), stacking concurrent uploads that fight over retention. A plain
  // boolean is enough inside this process; other processes are kept out by the
  // lease.
  let sweeping = false;
  const sweep = () => {
    currentSweep = (async () => {
      try {
        // Buffered view counts go out FIRST, before anything that can throw.
        // They are held only in memory, so a sweep that dies later must not take
        // them with it — and unlike the rest of this sweep, losing them cannot
        // be recovered by running again.
        await flushViews().catch((err) => {
          console.error('View flush failed:', err instanceof Error ? err.message : err);
        });
        const published = await publishDuePosts();
        // BEFORE the cancellation, so a reminder never describes an order that
        // has just been cancelled on the same tick.
        const { reminded } = await sweepRecoveryReminders();
        const { notified: restocked } = await sweepStockWaitlist();
        await import('./media/private-files-sweep').then((m) => m.sweepOrphanFormUploads()).catch((err) => console.error('Orphan upload sweep failed:', err instanceof Error ? err.message : err));
        const { cancelled } = await sweepAbandonedOrders();
        // The short hold on unpaid ONLINE payments (minutes, not days).
        const { expired } = await sweepPaymentHolds();
        // Before the money-moving sweeps, because it decides what a product
        // COSTS: an order placed in the same tick should be priced by the
        // window that is live now, not the one that was live a minute ago.
        const { repriced } = await sweepScheduledSales();
        await maybeBackUp();
        await maybeCheckLinks();
        await maybeSendCampaign();
        status = {
          ...status,
          lastRunAt: new Date().toISOString(),
          lastPublished: published,
          lastCancelled: cancelled + expired,
          lastReminded: reminded,
          lastRestocked: restocked,
          lastRepriced: repriced,
          lastError: null,
        };
      } catch (err) {
        // Recorded rather than swallowed. A sweep that has been failing since
        // the last deploy is exactly what an operator staring at an unpublished
        // scheduled post needs to see. lastPublished/lastCancelled are ZEROED
        // rather than carried over: leaving the previous successful sweep's
        // counts next to a fresh lastRunAt attributed an old sweep's numbers to
        // the failed one.
        status = {
          ...status,
          lastRunAt: new Date().toISOString(),
          lastPublished: 0,
          lastCancelled: 0,
          lastReminded: 0,
          lastRestocked: 0,
          lastRepriced: 0,
          lastError: err instanceof Error ? err.message : String(err),
        };
      } finally {
        sweeping = false;
        currentSweep = null;
        sweepCount += 1;
      }
    })();
  };
  const run = () => {
    if (stopping) return;
    void (async () => {
      // The lease FIRST, on every tick — including the ones that find a sweep
      // still running. A backup upload can outlast several intervals, and a
      // leader that renewed only between sweeps would lose the lease in the
      // middle of one and hand the next sweep to a second process.
      const leading = leadership ? await leadership.tick() : true;
      if (!leading || stopping || sweeping) return;
      sweeping = true;
      sweep();
    })();
  };
  run(); // sweep immediately so a restart catches anything overdue
  timer = setInterval(run, schedulerIntervalMs(env));
  // Don't let the timer alone keep the process alive (matters for short scripts);
  // the HTTP server keeps a real server running.
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/**
 * Stop scheduling sweeps, for a graceful shutdown (src/lib/shutdown.ts).
 *
 * Returns whether there was a timer to stop, so the shutdown log can say
 * which it was.
 *
 * `started` is deliberately NOT reset. The middleware calls startScheduler()
 * at module load, and a dev-server reload or a late import during the drain
 * would otherwise start a fresh interval on a process that is on its way out
 * — the sweep it launched would then be cut off by the exit this function
 * exists to make clean.
 *
 * A sweep that is ALREADY running is not interrupted — a half-sent batch is
 * worse than a finished one — but it stops at its next check
 * (`sweepMayContinue`), so it does not START a backup upload or a campaign
 * batch on a process that is leaving. The drain then waits for it, bounded,
 * with `awaitSchedulerSweep`, and gives the lease up with
 * `releaseSchedulerLease` once the last writes have landed. A backup upload
 * already under way can outlast that bound; the attempt marker it wrote
 * (backup/offsite-state.ts) is what stops the next process from starting the
 * same backup again straight away.
 */
export function stopScheduler(): boolean {
  stopping = true;
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  return true;
}

/**
 * Wait for a sweep that is still running, for at most `timeoutMs`.
 *
 * Resolves true when nothing is left running, false when the wait ran out. A
 * sweep never rejects (it records its own errors), so neither does this.
 */
export async function awaitSchedulerSweep(timeoutMs: number): Promise<boolean> {
  const running = currentSweep;
  if (!running) return true;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    expiry = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([running.then(() => true, () => true), expired]);
  } finally {
    clearTimeout(expiry);
  }
}

/**
 * Give the scheduler lease up, so a follower takes over at its next tick
 * instead of after the TTL. Resolves whether a lease of ours was removed.
 *
 * Called LAST in a drain — after the final view flush. On the libSQL doc-blob
 * driver a write replaces the whole document, so a successor whose first
 * sweep started while this process was still writing could overwrite that
 * write, or have its own overwritten.
 */
export async function releaseSchedulerLease(): Promise<boolean> {
  if (!leadership) return false;
  return leadership.release();
}

/**
 * Push an off-site backup, if one is configured and due.
 *
 * On the same timer as everything else rather than its own, because a second
 * interval is a second thing that can be running when the first is not — and
 * the operations screen would then have to explain which of them stopped.
 *
 * Never throws: a bucket that is refusing writes must not stop scheduled posts
 * from publishing. The outcome is recorded and shown on the screen.
 */
/**
 * Look at a few outbound links, if the operator asked for it.
 *
 * Opt-in and off by default, like the off-site backup above and for a related
 * reason: this makes requests from the operator's server to third-party hosts.
 * A shop that never enabled it must not be quietly generating outbound traffic,
 * and must not log an error every tick either.
 *
 * Eight per sweep, one per host — see the politeness note in
 * `link-check-external.ts`. At the default 60s cadence that is a slow, steady
 * trickle rather than a crawl, which is the right speed for something checking
 * other people's servers.
 */
/**
 * Send the next slice of a campaign that is mid-flight (C-111).
 *
 * On the EXISTING tick, never a second interval: two timers in one process is
 * two things to reason about when a send stalls, and the sweep already runs at
 * a cadence somebody chose.
 *
 * A batch at a time, resuming from the cursor on the record. A restart mid-send
 * therefore continues rather than starting again — sending a newsletter twice
 * is the failure people actually remember, and an operator cannot un-send it.
 *
 * ## Claimed before it is sent
 *
 * This used to read the cursor, send the batch, then write the cursor. Two
 * processes that read the same cursor each sent the same 25 people the same
 * newsletter — reproduced in tests/multi-instance.test.mjs by running two
 * sends side by side, on every driver.
 *
 * The scheduler lease now means only one process sweeps, so why claim as
 * well? Because the lease bounds the overlap, it does not remove it: a leader
 * that stalls past its TTL (a paused VM, a long GC) is replaced while its own
 * batch is still going, and a SIGKILL'd leader's successor starts from the
 * cursor as it was left. So the cursor moves FIRST, by a compare-and-set on
 * the value this process read (`updateCustomEntityIf`). A second sender's
 * claim then matches nothing and it sends nothing.
 *
 * The price is the other side of the same coin: a process that dies after
 * claiming and before finishing leaves up to one batch possibly unsent —
 * at most once, rather than at least once. That is the right way round for a
 * newsletter. The batch is counted in `unconfirmed_count` when it is claimed
 * and moved to sent/failed when it finishes, so an interrupted batch stays
 * visible on the record instead of vanishing.
 *
 * There is no "send now" path that bypasses this: the campaigns API only sets
 * `status: 'sending'`, and this function is the only sender.
 */
/** Whether the campaigns-off notice has been logged by this process. */
let campaignBlockNoted = false;

export async function maybeSendCampaign(): Promise<void> {
  try {
    const [
      { CAMPAIGN_TYPE, CAMPAIGN_BATCH_SIZE, nextBatch, campaignMessage },
      { sendBackgroundEmail, isOutcomeUnknown, emailChannelActive, campaignsEnabled },
      { resolveSiteUrl },
    ] = await Promise.all([
      import('./newsletter-campaign'),
      import('./email'),
      import('./site-url'),
    ]);
    if (!emailChannelActive()) return;
    if (!sweepMayContinue()) return;

    const rows = await LocalDB.getCustomEntities(CAMPAIGN_TYPE) as {
      id: string; data?: Record<string, unknown>;
    }[];
    const active = rows.find((r) => r.data?.status === 'sending');
    if (!active) return;

    // Checked HERE — after there is a campaign to send, before a batch of it is
    // claimed — and not left to sendEmail's own refusal of bulk mail. That
    // refusal would throw once per subscriber, the loop below would count every
    // one of them as failed, and the cursor would walk the whole list to "sent"
    // with nothing delivered. A campaign queued before the flag was set simply
    // waits, and the log says why, once per process rather than once a minute.
    if (!campaignsEnabled()) {
      if (!campaignBlockNoted) {
        campaignBlockNoted = true;
        console.warn('[astrobaas] newsletter campaign waiting: EMAIL_CAMPAIGNS=0, so it will not be sent through this mail channel.');
      }
      return;
    }

    const subscribers = await LocalDB.getSubscribers();
    const cursor = Number(active.data?.cursor ?? 0) || 0;
    // The cursor EXACTLY as stored is what the claim compares against. A
    // record from before the cursor existed has none (null).
    const stored = active.data?.cursor;
    const expected = {
      cursor: typeof stored === 'number' || typeof stored === 'string' ? stored : null,
      status: 'sending',
    };
    const batch = nextBatch(subscribers, cursor, CAMPAIGN_BATCH_SIZE);
    if (batch.length === 0) {
      await LocalDB.updateCustomEntityIf(CAMPAIGN_TYPE, active.id, expected, { status: 'sent' });
      return;
    }

    // The cursor moves by the WHOLE batch, including the failures. Retrying a
    // failure on the next tick would retry it forever on a permanently bad
    // address, and the campaign would never finish.
    const nextCursor = cursor + batch.length;
    const unconfirmed = Number(active.data?.unconfirmed_count ?? 0) || 0;
    const claimed = await LocalDB.updateCustomEntityIf(CAMPAIGN_TYPE, active.id, expected, {
      cursor: nextCursor,
      unconfirmed_count: unconfirmed + batch.length,
    });
    // Somebody else moved the cursor first: this slice is theirs.
    if (!claimed) return;

    const setting = await LocalDB.getSetting('site_url');
    const origin = resolveSiteUrl({ setting: setting?.value });
    let sent = 0;
    let failed = 0;
    let unknown = 0;

    for (const sub of batch) {
      try {
        // The background send: the wait for the server to answer each message
        // is a minute, not ten, so one silent server cannot hold every other
        // job on this tick behind a 25-address batch for hours.
        await sendBackgroundEmail(campaignMessage(
          { subject: String(active.data?.subject ?? ''), body: String(active.data?.body ?? '') },
          sub.email,
          origin ?? '',
        ));
        sent += 1;
      } catch (err) {
        // One bad address must not stop the run. The count is what an operator
        // reads afterwards; stopping would leave the rest of the list unsent
        // with nothing saying why.
        //
        // A message whose outcome is UNKNOWN (sent, never answered) is not a
        // failure: it may have arrived. It is counted where the campaign already
        // counts "may or may not have received it, and not resent" —
        // unconfirmed — rather than as failed.
        if (isOutcomeUnknown(err)) unknown += 1;
        else failed += 1;
      }
    }

    // Counts are added to what is stored NOW, not to what was read before the
    // send: the record may have moved meanwhile, and only these deltas are
    // this batch's to add.
    const fresh = await LocalDB.getCustomEntity(CAMPAIGN_TYPE, active.id) as
      { data?: Record<string, unknown> } | undefined;
    const d = fresh?.data ?? {};
    const num = (v: unknown) => Number(v ?? 0) || 0;
    await LocalDB.updateCustomEntity(CAMPAIGN_TYPE, active.id, {
      sent_count: num(d.sent_count) + sent,
      failed_count: num(d.failed_count) + failed,
      unconfirmed_count: Math.max(0, num(d.unconfirmed_count) - batch.length) + unknown,
      ...(d.status === 'sending' && num(d.cursor) >= subscribers.length ? { status: 'sent' } : {}),
    });
  } catch (err) {
    console.error('[astrobaas] campaign send failed:', err);
  }
}

async function maybeCheckLinks(): Promise<void> {
  try {
    const enabled = await LocalDB.getSetting('link_check_external');
    const v = enabled?.value;
    if (!(v === true || v === 'true' || v === '1')) return;

    const [{ collectExternalLinks }, { sweepExternalLinks }, { resolveSiteUrl }] = await Promise.all([
      import('./link-check'),
      import('./link-check-external'),
      import('./site-url'),
    ]);
    const posts = await LocalDB.getPosts();
    const siteUrl = await LocalDB.getSetting('site_url');
    const origin = resolveSiteUrl({ setting: siteUrl?.value });
    const urls = [...collectExternalLinks(posts, origin).keys()];
    if (urls.length === 0) return;
    await sweepExternalLinks(urls);
  } catch (err) {
    // Never fatal. A link checker that can take down the scheduler would stop
    // scheduled posts from publishing, which matters far more than this does.
    console.error('[astrobaas] link check sweep failed:', err instanceof Error ? err.message : err);
  }
}

async function maybeBackUp(): Promise<void> {
  try {
    const { offsiteConfig, backupDue, lastBackup } = await import('./backup/offsite');
    const cfg = offsiteConfig();
    // Not configured is the normal state. Off-site backup is opt-in, and a
    // site with no bucket must not log an error every tick.
    if (!cfg) return;
    if (!sweepMayContinue()) return;
    // The PERSISTED record decides, not only this process's memory: a restart
    // must not mean a fresh full backup, and an attempt that a crash cut off
    // must not be started again by every process that comes up after it.
    const { readOffsiteState, runRecordedBackup } = await import('./backup/offsite-state');
    const state = await readOffsiteState();
    if (!backupDue(cfg, lastBackup(), Date.now(), state)) return;
    const result = await runRecordedBackup(cfg);
    if (result.ok) {
      console.log(`[astrobaas] off-site backup uploaded: ${result.key} (${result.bytes} bytes, pruned ${result.pruned})`);
    } else {
      console.error(`[astrobaas] off-site backup FAILED: ${result.error}`);
    }
  } catch (err) {
    console.error('[astrobaas] off-site backup errored:', err instanceof Error ? err.message : err);
  }
}

/**
 * Open and close scheduled sales.
 *
 * ## The bug this exists for
 *
 * `sale_starts_at` and `sale_ends_at` are stored, validated and honoured by
 * `deriveSaleState()` — which every WRITE path goes through. Nothing read them
 * on a clock, so a sale queued for Friday midnight did not begin until somebody
 * opened the product and saved it, and a sale that had ended kept selling at
 * the sale price for the same reason. `models.ts` said so in as many words.
 *
 * It bites in both directions and the second one costs more: a sale that will
 * not start is a promotion that silently did nothing, and a sale that will not
 * end is margin leaving the building on every order until an editor happens to
 * touch that product.
 *
 * Checkout reads the STORED `price_cents` for a simple product
 * (`resolvePurchasable`), so this is the price a customer is actually charged,
 * not a display detail.
 *
 * ## Why it re-derives rather than flipping a flag
 *
 * `deriveSaleState` is the one place that decides what counts as a sale — it
 * refuses a "sale" priced at or above the regular price, which is what stops a
 * bad feed advertising a discount that does not exist. A sweep that set
 * `on_sale = true` itself would be a second opinion on that question, and the
 * two would eventually disagree. Passing an EMPTY patch means every value comes
 * from what is stored; only the clock has moved.
 *
 * Variants need no sweep of their own: `resolvePurchasable` derives their price
 * at read time from the parent's window, so they are already correct.
 */
export async function sweepScheduledSales(
  nowMs: number = Date.now(),
): Promise<{ repriced: number }> {
  const { LocalDB } = await import('./localdb');
  const { deriveSaleState } = await import('./product-fields');

  await LocalDB.init();
  const products = await LocalDB.getProducts();

  let repriced = 0;
  for (const product of products) {
    // Only products the clock can move — and this is a CORRECTNESS guard, not
    // just a cost one.
    //
    // With no window, `saleActiveAt` returns null, and `deriveSaleState`
    // computes `on_sale = sale !== null && sale < regular && window !== false`.
    // `null !== false` is true. So an operator who typed a sale price and has
    // not switched it on would have that sale SWITCHED ON by the next tick.
    //
    // On a save that derivation is what the operator asked for. In a background
    // pass it is the catalogue changing behind their back, which is the one
    // thing a sweep must never do.
    if (!product.sale_starts_at && !product.sale_ends_at) continue;

    const next = deriveSaleState({}, product, nowMs);
    // Compare only what the clock can have changed. An equality check on the
    // whole object would rewrite rows whose `regular_price_cents` was merely
    // absent, which is the write this guard exists to avoid.
    if (next.on_sale === product.on_sale && next.price_cents === product.price_cents) continue;

    // The third place a price moves, and the least obvious: a sale opening or
    // closing on the clock is a price change nobody typed, and the Omnibus rule
    // does not care who moved it.
    const { recordPrice } = await import('./commerce/price-history');
    await LocalDB.updateProduct(product.id, {
      on_sale: next.on_sale,
      price_cents: next.price_cents,
      regular_price_cents: next.regular_price_cents,
      sale_price_cents: next.sale_price_cents,
      price_history: recordPrice(product.price_history, next.price_cents, nowMs),
    }).catch(() => {});
    repriced += 1;
  }

  if (repriced) {
    console.log(`[astrobaas] repriced ${repriced} product(s) whose sale window opened or closed`);
  }
  return { repriced };
}

/**
 * Tell the people waiting that a product is back.
 *
 * Asks the question the opposite way round from a hook: of the people waiting,
 * whose product can now be bought? Stock arrives through an operator edit, a
 * cancellation returning reserved units, a refund and a bulk import, and
 * hooking each of those is the sibling gap this codebase keeps finding. This is
 * correct however the stock arrived.
 *
 * The row is DELETED once the notice is sent, so there is nothing to
 * unsubscribe from and no address left sitting in a table. Rows whose product
 * has been deleted go the same way — a waitlist that only grows is a pile of
 * email addresses nobody is looking after.
 *
 * BATCHED: at most `stock_waitlist_batch_size` notices per tick (default 50),
 * oldest request first. The rest stay in the table untouched and are the next
 * tick's work — see `resolveWaitlistBatchSize` for why a restock must not
 * become one burst. `deferred` reports how many are still due.
 */
export async function sweepStockWaitlist(
  nowMs: number = Date.now(),
): Promise<{ notified: number; deferred: number }> {
  const { LocalDB } = await import('./localdb');
  const {
    WAITLIST_TYPE, selectWaitlistToNotify, resolveWaitlistBatchSize, waitlistBatch,
  } = await import('./commerce/stock-waitlist');

  await LocalDB.init();
  const rows = await LocalDB.getCustomEntities(WAITLIST_TYPE) as {
    id: string; data?: Record<string, unknown> }[];
  if (rows.length === 0) return { notified: 0, deferred: 0 };

  const products = new Map((await LocalDB.getProducts()).map((p) => [p.id, p]));
  const waiting = rows
    .filter((r) => r.data && typeof r.data.product_id === 'string' && typeof r.data.email === 'string')
    .map((r) => ({
      id: r.id,
      product_id: String(r.data!.product_id),
      variant_id: typeof r.data!.variant_id === 'string' ? r.data!.variant_id : undefined,
      email: String(r.data!.email),
      created_at: String(r.data!.created_at ?? ''),
    }));

  const { notify, stale } = selectWaitlistToNotify(waiting, products);

  // Rows for products that no longer exist are cleaned up whether or not
  // anything is sent this tick.
  for (const row of stale) {
    await LocalDB.deleteCustomEntity(WAITLIST_TYPE, row.id).catch(() => {});
  }
  if (notify.length === 0) return { notified: 0, deferred: 0 };

  // The background send: see sendBackgroundEmail — a minute's wait for the
  // server to answer each notice, not ten, because the sweep waits behind them.
  const [{ sendBackgroundEmail }, { renderEmailTemplate, emailTemplateKey }] = await Promise.all([
    import('./email'),
    import('./email-templates'),
  ]);
  const settingRows = await LocalDB.getSettings();
  const map: Record<string, unknown> = {};
  for (const r of settingRows) map[r.key] = r.value;
  const siteTitle = typeof map.site_title === 'string' ? map.site_title : 'The shop';
  const origin = typeof map.site_url === 'string' && map.site_url.trim()
    ? map.site_url.trim().replace(/\/$/, '')
    : (process.env.SITE_URL ?? '').replace(/\/$/, '');

  // This tick's share, oldest first. Everything past it is left exactly where
  // it is: still in the table, still due, and picked up by the next tick.
  const batch = waitlistBatch(notify, resolveWaitlistBatchSize(map));
  const deferred = notify.length - batch.length;

  let notified = 0;
  for (const row of batch) {
    const product = products.get(row.product_id)!;
    // Deleted FIRST, for the same reason `recovery_sent_at` is stamped first: a
    // transport that is down must not turn one notice into a nightly one.
    //
    // And the delete is the CLAIM: only a delete that actually removed the row
    // earns a send. A delete that failed leaves the row for the next tick (sent
    // then, once), and a delete that found nothing means somebody else — an
    // overlapping sweep, a GDPR erasure — already took it. Sending anyway was
    // how a storage blip turned into the same notice every minute.
    const claimed = await LocalDB.deleteCustomEntity(WAITLIST_TYPE, row.id).catch(() => false);
    if (!claimed) continue;
    notified += 1;
    try {
      const link = origin ? `${origin}/shop/${encodeURIComponent(product.slug)}` : '';
      const rendered = renderEmailTemplate('stock_back', {
        site_title: siteTitle,
        product_name: product.name,
        product_url: link,
      }, map[emailTemplateKey('stock_back')]);
      const text = [
        `${product.name} is back in stock.`,
        '',
        link ? link : '',
        '',
        siteTitle,
      ].filter((l) => l !== undefined).join('\n');
      await sendBackgroundEmail({
        to: row.email,
        subject: rendered?.subject || `${siteTitle} — ${product.name} is back in stock`,
        text,
        // Escaped: the product name and site title are text typed into the
        // admin, and this is HTML a customer's mail client renders. A name like
        // `Frames <b>50% off</b>` (or worse) used to arrive as markup.
        html: `<p><strong>${escapeHtml(product.name)}</strong> is back in stock.</p>`
          + (link ? `<p><a href="${escapeHtml(link)}">View it</a></p>` : '')
          + `<p>${escapeHtml(siteTitle)}</p>`,
      });
    } catch (err) {
      console.error('Back-in-stock notice failed:', err instanceof Error ? err.message : err);
    }
  }
  if (notified) console.log(`[astrobaas] told ${notified} customer(s) a product is back`);
  if (deferred) console.log(`[astrobaas] ${deferred} back-in-stock notice(s) left for the next tick`);
  return { notified, deferred };
}

/**
 * One reminder to a customer whose order is still unpaid.
 *
 * Runs BEFORE the cancellation sweep on the same tick, and that order matters:
 * a reminder sent after the order was cancelled is a message about something
 * that no longer exists. `resolveRecoverySettings` also clamps the delay below
 * the cancellation deadline so the two cannot cross.
 *
 * `recovery_sent_at` is stamped BEFORE the send and regardless of whether it
 * succeeds. A transport that is down would otherwise turn one reminder into a
 * nightly one, which is the failure mode a recipient reports as spam.
 */
export async function sweepRecoveryReminders(
  nowMs: number = Date.now(),
): Promise<{ reminded: number }> {
  const { LocalDB } = await import('./localdb');
  const { resolveAbandonmentSettings, resolveRecoverySettings, selectForReminder } =
    await import('./commerce/abandonment');

  await LocalDB.init();
  const rows = await LocalDB.getSettings();
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;

  const abandonment = resolveAbandonmentSettings(map);
  const recovery = resolveRecoverySettings(map, abandonment);
  if (!recovery.enabled) return { reminded: 0 };

  const orders = await LocalDB.getOrders();
  const due = selectForReminder(orders as never[], abandonment, recovery, nowMs);
  if (due.length === 0) return { reminded: 0 };

  // The background send, like the restock notices: see sendBackgroundEmail.
  const [{ sendBackgroundEmail }, { buildRecoveryNotice }, { renderEmailTemplate, emailTemplateKey },
         { manualInstructions }, { defaultLocale }] = await Promise.all([
    import('./email'),
    import('./commerce/recovery-notice'),
    import('./email-templates'),
    import('./payments/registry'),
    import('./i18n'),
  ]);
  const siteTitle = typeof map.site_title === 'string' ? map.site_title : undefined;

  let reminded = 0;
  for (const order of due as never as import('../core/models').Order[]) {
    // Stamped first. See the docblock: the guard must hold even when the send
    // throws, or a broken transport becomes a nightly reminder.
    await LocalDB.updateOrder(order.id, {
      recovery_sent_at: new Date(nowMs).toISOString(),
    }).catch(() => {});
    reminded += 1;

    try {
      const created = Date.parse(order.created_at ?? '');
      const daysLeft = Number.isFinite(created)
        ? Math.max(0, Math.ceil(abandonment.days - (nowMs - created) / 86_400_000))
        : undefined;
      const rendered = renderEmailTemplate('order_recovery', {
        site_title: siteTitle ?? 'Your order',
        order_number: String(order.number ?? order.id),
      }, map[emailTemplateKey('order_recovery')]);
      const msg = buildRecoveryNotice(order, {
        siteTitle,
        subject: rendered?.subject,
        daysLeft,
        instructions: manualInstructions(String(order.payment_method ?? ''), map, defaultLocale()),
      });
      if (msg) await sendBackgroundEmail(msg);
    } catch (err) {
      console.error('Recovery reminder failed:', err instanceof Error ? err.message : err);
    }
  }
  if (reminded) console.log(`[astrobaas] reminded ${reminded} customer(s) of an unpaid order`);
  return { reminded };
}

/**
 * Cancel orders that were never paid, returning their stock.
 *
 * Runs on the same timer as the scheduled-post sweep. Cancellation goes through
 * `setOrderStatus`, so inventory is credited by exactly the code an operator's
 * manual cancel uses — a second stock path would be a second thing to get
 * wrong.
 */
export async function sweepAbandonedOrders(
  nowMs: number = Date.now(),
): Promise<{ cancelled: number }> {
  const { LocalDB } = await import('./localdb');
  const { setOrderStatus } = await import('./commerce-service');
  const { resolveAbandonmentSettings, selectAbandoned, shouldAbandon } = await import('./commerce/abandonment');
  const { recordAudit } = await import('./audit');

  await LocalDB.init();
  const rows = await LocalDB.getSettings();
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;
  const settings = resolveAbandonmentSettings(map);
  if (!settings.enabled) return { cancelled: 0 };

  const orders = await LocalDB.getOrders();
  const stale = selectAbandoned(orders, settings, nowMs);

  let cancelled = 0;
  for (const order of stale) {
    // `stale` was chosen from a list read before this loop, and the loop
    // awaits between orders: by the time it reaches one, the payment may have
    // landed or staff may have cancelled it. So the decision is taken again on
    // the order as it is NOW, inside setOrderStatus, with the payment status
    // pinned for the write. Without it the sweep cancelled (and released the
    // stock of) an order paid a moment earlier, and answered "ok" for one
    // staff had already cancelled — and then stamped it as abandoned.
    const res = await setOrderStatus(order.id, 'cancelled', 'system:abandonment', {
      when: (fresh) => {
        const decision = shouldAbandon(fresh, settings, nowMs);
        return decision.abandon ? null : `No longer abandonable (${decision.reason})`;
      },
      // Record WHY, so an operator looking at a cancelled order can tell an
      // abandonment from a customer changing their mind — in the same write
      // as the cancel (SetOrderStatusOptions.cancelledReason), because the
      // reason is also what lets a late PayPal approval reopen the order.
      cancelledReason: 'abandoned',
    });
    if (!res.ok) continue;
    await LocalDB.updateOrder(order.id, {
      abandoned_at: new Date(nowMs).toISOString(),
    }).catch(() => {});
    recordAudit('order.abandoned', {
      actor: 'system',
      target: order.id,
      metadata: { order: order.number, after_days: settings.days },
    });
    cancelled++;
  }
  if (cancelled) console.log(`[astrobaas] abandoned ${cancelled} unpaid order(s) older than ${settings.days}d`);
  return { cancelled };
}

/**
 * Cancel unpaid ONLINE-payment orders whose payment hold has run out,
 * returning their stock (commerce/payment-hold.ts).
 *
 * The same shape as sweepAbandonedOrders, deliberately: the list is read
 * once, and each cancellation goes through setOrderStatus with the decision
 * asked AGAIN on the order as it is at the write — a payment can land between
 * the list and the move — and the payment status pinned for the write. So the
 * stock is handed back exactly once, and never for an order paid meanwhile.
 *
 * Bounded: only the last week of orders is read. A hold is at most a day, so
 * anything older is past it already, and the day-based sweep bounds it.
 */
export async function sweepPaymentHolds(
  nowMs: number = Date.now(),
): Promise<{ expired: number }> {
  const { LocalDB } = await import('./localdb');
  const { setOrderStatus } = await import('./commerce-service');
  const { resolvePaymentHoldSettings, selectExpiredHolds, shouldExpireHold } = await import('./commerce/payment-hold');
  const { onlineMethodIds } = await import('./payments/registry');
  const { recordAudit } = await import('./audit');

  await LocalDB.init();
  const rows = await LocalDB.getSettings();
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;
  const settings = resolvePaymentHoldSettings(map);
  if (settings.holdMinutes <= 0) return { expired: 0 };

  const ids = onlineMethodIds();
  const recent = await LocalDB.getRecentOrders({
    since: new Date(nowMs - 7 * 86_400_000).toISOString(),
    atMost: 20_000,
  });
  const due = selectExpiredHolds(recent, settings, ids, nowMs);

  let expired = 0;
  for (const order of due) {
    const res = await setOrderStatus(order.id, 'cancelled', 'system:payment-hold', {
      when: (fresh) => {
        const decision = shouldExpireHold(fresh, settings, ids, nowMs);
        return decision.expire ? null : `No longer due to expire (${decision.reason})`;
      },
      // In the same write as the cancel — see sweepAbandonedOrders.
      cancelledReason: 'hold-expired',
    });
    if (!res.ok) continue;
    await LocalDB.updateOrder(order.id, {
      hold_expired_at: new Date(nowMs).toISOString(),
    }).catch(() => {});
    recordAudit('order.hold_expired', {
      actor: 'system',
      target: order.id,
      metadata: { order: order.number, after_minutes: settings.holdMinutes, method: order.payment_method },
    });
    expired++;
  }
  if (expired) console.log(`[astrobaas] released ${expired} unpaid online order(s) past the ${settings.holdMinutes}-minute payment hold`);
  return { expired };
}
