import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { callAssistant } from '../../../lib/ai-assistant';
import { liveAssistantConfig } from '../../../lib/assistant-runtime';
import { ensurePluginsBootstrapped } from '../../../plugins';
import { canAuthorPosts } from '../../../lib/auth';
import { locales } from '../../../lib/i18n';
import {
  AI_TASKS, AI_TASK_REPLY_TOKENS, getAiTask, taskPrompt, taskInputProblem, cleanTaskReply,
} from '../../../lib/ai-tasks';

export const prerender = false;

/**
 * POST /api/assistant/assist — run one editorial AI task (C-163, C-134).
 *
 * ## How this differs from /api/assistant/chat, and why it is a separate route
 *
 * The chat endpoint is PUBLIC: it exists so an anonymous visitor can talk to the
 * shop's bubble, and everything it does is shaped by that. This one is the
 * opposite in every respect that matters:
 *
 *  - **authenticated**, and gated on `author_posts` — the same capability that
 *    decides who may write a post at all. Somebody who cannot write a post has
 *    no editorial reason to spend the operator's tokens.
 *  - the system prompt is OURS, per task, and the operator's visitor-facing
 *    persona is deliberately not inherited (see ai-tasks.ts).
 *  - the reply budget is five times the bubble's, because a rewrite has to come
 *    back whole.
 *
 * Sharing one route would mean a public endpoint that reads a task id, and one
 * missing check away from an anonymous visitor running 4000-token rewrites on
 * the operator's account.
 *
 * ## It never writes
 *
 * The answer goes back to the browser. A person reads it and presses save. This
 * is the whole reason "draft translation" is safe to offer: nothing exists until
 * an editor has looked at it, and a machine translation nobody read is the
 * failure mode C-134 has to avoid, not the feature.
 *
 * ## Cost
 *
 * Every call spends the operator's own credit — there is no AstroBaaS key. So
 * the input is bounded per task before the request is made, and the route
 * inherits the middleware's per-IP limit like every other write.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canAuthorPosts(user.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot use the writing assistant');
    }

    await LocalDB.init();
    // The activation list is empty until this has run, so a cold request would
    // otherwise 404 a live assistant.
    await ensurePluginsBootstrapped();
    // 404, matching the chat route: an assistant that is off looks like it does
    // not exist rather than like something to keep probing.
    const cfg = await liveAssistantConfig();
    if (!cfg) return ApiResponseBuilder.notFound('Assistant');

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const task = getAiTask(typeof body?.task === 'string' ? body.task : '');
    if (!task) {
      return ApiResponseBuilder.badRequest(`task must be one of: ${AI_TASKS.map((t) => t.id).join(', ')}`);
    }

    const text = typeof body?.text === 'string' ? body.text : '';
    const target = typeof body?.locale === 'string' ? body.locale : '';

    // A target locale has to be one this install actually runs. Anything else
    // and an editor could translate into a language with nowhere to put it —
    // and the language name would come from arbitrary caller input.
    if (task.needsLocale && !locales().includes(target)) {
      return ApiResponseBuilder.badRequest(`locale must be one of: ${locales().join(', ')}`);
    }

    const problem = taskInputProblem(task, text, target);
    if (problem) return ApiResponseBuilder.badRequest(problem);

    const prompt = taskPrompt(task, target);
    if (!prompt) return ApiResponseBuilder.badRequest('That action is not available.');

    const reply = await callAssistant(
      // The operator's credential and endpoint, OUR instruction and budget.
      { ...cfg, systemPrompt: prompt },
      { message: text, history: [] },
      undefined,
      undefined,
      AI_TASK_REPLY_TOKENS,
    );

    if (!reply.ok || !reply.reply) {
      if (reply.failure) console.error('AI task failed:', reply.failure);
      // The caller is a signed-in editor, not a visitor — but provider errors
      // still name accounts and quotas, so they stay in the log.
      return ApiResponseBuilder.serverError(reply.error ?? 'The assistant is unavailable right now.');
    }

    return ApiResponseBuilder.success({ task: task.id, text: cleanTaskReply(task, reply.reply) }, task.label);
  } catch (err) {
    console.error('AI task error:', err);
    return ApiResponseBuilder.serverError('Could not run that action');
  }
};

/** The catalogue, so the editor screen does not hard-code a second copy of it. */
export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return ApiResponseBuilder.unauthorized();
  if (!canAuthorPosts(user.role)) return ApiResponseBuilder.forbidden('Your role cannot use the writing assistant');
  await LocalDB.init();
  await ensurePluginsBootstrapped();
  const live = (await liveAssistantConfig()) !== null;
  return ApiResponseBuilder.success({
    live,
    tasks: AI_TASKS.map((t) => ({ id: t.id, label: t.label, hint: t.hint, needsLocale: t.needsLocale === true })),
    locales: locales(),
  }, 'Editorial AI tasks');
};
