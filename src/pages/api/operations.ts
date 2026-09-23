import type { APIRoute } from 'astro';
import { LocalDB } from '../../lib/localdb';
import { ApiResponseBuilder } from '../../lib/api-response';
import { schedulerStatus } from '../../lib/scheduler';
import { emailChannelActive, lastSendOutcome, getEmailTransport } from '../../lib/email';
import { isPostDue } from '../../lib/scheduler-util';
import { offsiteConfig, lastBackup, backupDue } from '../../lib/backup/offsite';
import { readOffsiteState } from '../../lib/backup/offsite-state';
import type { EmailLogEntry, Post } from '../../core/models';

/**
 * What the background parts of this install have been doing.
 *
 * Two questions an operator cannot currently answer from the admin at all:
 *
 *   "Why has my scheduled post not gone live?"
 *   "Did that order confirmation actually get sent?"
 *
 * Both were answerable only by reading server logs, which most people running
 * a small shop cannot do and should not have to.
 *
 * Admin only. The email log carries recipient addresses, and the scheduler
 * status describes the process — neither is customer-facing information.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    if (locals.user.role !== 'admin') {
      return ApiResponseBuilder.forbidden('Only an administrator can see this');
    }
    await LocalDB.init();

    const limitRaw = Number(new URL(url).searchParams.get('limit'));
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;

    const posts = (await LocalDB.getPosts()) as Post[];
    const now = Date.now();
    const scheduled = posts.filter((p) => p.status === 'scheduled');
    // Due but still scheduled means the sweep has not caught it yet — either
    // it is about to, or it is not running. This is the number the screen is
    // for.
    const overdue = scheduled.filter((p) => isPostDue(p, now));

    return ApiResponseBuilder.success({
      scheduler: {
        ...schedulerStatus(),
        scheduled: scheduled.length,
        overdue: overdue.length,
        next: scheduled
          .map((p) => p.publish_date)
          .filter((d): d is string => typeof d === 'string')
          .sort()
          .find((d) => new Date(d).getTime() > now) ?? null,
        overdueTitles: overdue.slice(0, 10).map((p) => ({ title: p.title, slug: p.slug, due: p.publish_date })),
      },
      backup: await (async () => {
        const cfg = offsiteConfig();
        if (!cfg) {
          return { configured: false as const };
        }
        // The PERSISTED record first: it survives restarts and is shared by
        // replicas, so the screen no longer says "no backup has run" after
        // every deploy. This process's memory is the fallback when the record
        // cannot be read.
        const persisted = await readOffsiteState().catch(() => null);
        const mine = lastBackup();
        const last = [persisted?.last ?? null, mine]
          .filter((o): o is NonNullable<typeof o> => !!o)
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
        // The bucket and prefix, never the credentials. This response goes to
        // a browser.
        return {
          configured: true as const,
          target: `${cfg.endpoint}/${cfg.bucket}/${cfg.prefix}`,
          everyHours: cfg.everyHours,
          keep: cfg.keep,
          last,
          lastSuccess: persisted?.last_success ?? (mine?.ok ? mine : null),
          /** An attempt that has started and not finished — on any process. */
          inProgress: persisted?.attempt ?? null,
          due: backupDue(cfg, mine, now, persisted),
        };
      })(),
      email: {
        channelActive: emailChannelActive(),
        transport: getEmailTransport().name,
        lastSend: lastSendOutcome(),
        recent: (await LocalDB.getEmailLog(limit)) as EmailLogEntry[],
      },
    }, undefined, { limit });
  } catch (err) {
    console.error('Operations status error:', err);
    return ApiResponseBuilder.serverError('Failed to read the operations status');
  }
};
