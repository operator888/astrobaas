/**
 * The public form SCHEMA (C-22).
 *
 * ## Why this exists
 *
 * The form builder shipped as an SSR page: an operator defines a type and
 * `/forms/<type>` renders it. Both production installs are headless Next.js
 * storefronts, so for the people who matter the form builder did not exist —
 * they had no way to learn what fields a type declares. `GET /api/content-types`
 * is staff-only, deliberately: it lists every collection on the site including
 * the private ones.
 *
 * This is the narrow, public half. It answers for ONE type, only when that type
 * has opted in to public writes, and it returns only what a form needs to be
 * drawn: the label, the fields, the steps and the conditions.
 *
 * ## What it deliberately does not say
 *
 * Nothing about the collection's READ policy, its stored records, or its
 * existence when it does not accept public writes. A type that has not opted
 * in gets the same 404 an unknown name gets, so this cannot be used to
 * enumerate what a site stores — the same rule `/forms/<type>` follows.
 *
 * And the response is not a permission: `showIf` is presentation. The server
 * re-evaluates every condition in `schemaForSubmission` on the way in, so a
 * caller that ignores this document entirely gets the same answer.
 */
import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { getContentType, contentTypeAcceptsPublicWrites, stepCount } from '../../../core/content-types';
import { ensurePluginsBootstrapped } from '../../../plugins';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();

    const type = String((params as { type?: string }).type || '');
    const def = getContentType(type);
    // One 404 for "no such type" and for "that type does not take public
    // submissions" — telling them apart is an enumeration oracle.
    if (!def || !contentTypeAcceptsPublicWrites(def)) {
      return ApiResponseBuilder.notFound('Form');
    }

    return ApiResponseBuilder.success({
      name: def.name,
      label: def.label,
      labelPlural: def.labelPlural ?? null,
      steps: def.steps ?? null,
      stepCount: stepCount(def),
      fields: def.fields.map((f) => ({
        name: f.name,
        label: f.label ?? null,
        rule: f.rule,
        step: f.step ?? 1,
        showIf: f.showIf ?? null,
      })),
      /**
       * The two meta-fields a submission carries beside the declared ones, named
       * here so a storefront does not have to read this codebase to find them.
       * `honeypot` must be present and EMPTY; `powField` carries the anti-spam
       * answer from `/captcha.js`.
       */
      honeypot: 'hp_url',
      powField: 'pow_token',
      submitTo: `/api/content/${encodeURIComponent(def.name)}`,
    }, 'Form schema');
  } catch (err) {
    console.error('Form schema error:', err);
    return ApiResponseBuilder.serverError('Could not load the form');
  }
};
