import type { APIRoute } from 'astro';
import { LocalDB } from '../../lib/localdb';
import { ApiResponseBuilder } from '../../lib/api-response';
import {
  EMAIL_TEMPLATES, getEmailTemplate, emailTemplateKey,
  readOverride, templateProblem, renderEmailTemplate,
} from '../../lib/email-templates';

export const prerender = false;

/**
 * GET /api/email-templates      — the catalogue plus whatever is customised
 * PUT /api/email-templates      — save one template's wording
 * DELETE /api/email-templates?id=… — go back to the built-in wording
 *
 * Admin only. These emails carry password resets and sign-in links; the ability
 * to reword them is the ability to phrase a phishing message in the site's own
 * voice, from the site's own address.
 *
 * Every write is validated by the SAME function the renderer validates with, so
 * "it saved" and "it will actually be used" cannot come apart. A template that
 * fails validation at render time falls back to the built-in wording rather
 * than sending something broken.
 */

const isAdmin = (locals: App.Locals) => locals.user?.role === 'admin';

/** Sample values, so the preview shows a real email rather than braces. */
const SAMPLE: Record<string, string> = {
  site_title: 'Your site',
  order_number: 'A-1042',
  customer_name: 'Maria',
  order_total: '€128.00',
  order_lines: '  1 × Frame — €98.00\n  1 × Lenses — €30.00',
  payment_instructions: 'Transfer to GR00 0000 0000 0000, reference A-1042.',
  reset_link: 'https://example.com/reset-password?token=…',
  sign_in_link: 'https://example.com/api/auth/magic?token=…',
  confirm_link: 'https://example.com/api/newsletter/confirm?token=…',
  expires_in: 'one hour',
  what: 'contact message',
  admin_link: 'https://example.com/admin/messages',
};

export const GET: APIRoute = async ({ locals }) => {
  try {
    if (!isAdmin(locals)) return ApiResponseBuilder.forbidden('Only an admin can read email templates');
    await LocalDB.init();

    const templates = [];
    for (const def of EMAIL_TEMPLATES) {
      const stored = (await LocalDB.getSetting(emailTemplateKey(def.id)))?.value;
      const override = readOverride(def, stored);
      templates.push({
        id: def.id,
        label: def.label,
        when: def.when,
        placeholders: def.placeholders,
        required: def.required,
        subjectOnly: def.subjectOnly === true,
        defaultSubject: def.defaultSubject,
        defaultBody: def.defaultBody,
        subject: override?.subject ?? def.defaultSubject,
        body: override?.body ?? def.defaultBody,
        customised: override !== null,
        // A preview of what actually goes out, rendered by the real renderer.
        preview: renderEmailTemplate(def.id, SAMPLE, stored),
      });
    }
    return ApiResponseBuilder.success({ templates }, 'Email templates');
  } catch (err) {
    console.error('Email template read error:', err);
    return ApiResponseBuilder.serverError('Could not read the email templates');
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    if (!isAdmin(locals)) return ApiResponseBuilder.forbidden('Only an admin can change email templates');
    await LocalDB.init();

    const body = await request.json().catch(() => null) as
      { id?: unknown; subject?: unknown; body?: unknown } | null;
    const def = getEmailTemplate(String(body?.id ?? ''));
    if (!def) return ApiResponseBuilder.notFound('Email template');

    const edit = { subject: String(body?.subject ?? ''), body: String(body?.body ?? '') };
    const problem = templateProblem(def, edit);
    // The refusal names the thing to fix. "Invalid template" is a message an
    // operator can only respond to by giving up.
    if (problem) return ApiResponseBuilder.badRequest(problem);

    await LocalDB.updateSetting(emailTemplateKey(def.id), {
      subject: edit.subject.trim(),
      // A subject-only template stores no body, so a later change to the
      // built-in document reaches the operator instead of being shadowed by a
      // copy they never meant to keep.
      body: def.subjectOnly ? '' : edit.body,
    });

    const stored = (await LocalDB.getSetting(emailTemplateKey(def.id)))?.value;
    return ApiResponseBuilder.success(
      { id: def.id, preview: renderEmailTemplate(def.id, SAMPLE, stored) },
      `${def.label} saved`,
    );
  } catch (err) {
    console.error('Email template write error:', err);
    return ApiResponseBuilder.serverError('Could not save that email template');
  }
};

export const DELETE: APIRoute = async ({ url, locals }) => {
  try {
    if (!isAdmin(locals)) return ApiResponseBuilder.forbidden('Only an admin can change email templates');
    await LocalDB.init();
    const def = getEmailTemplate(new URL(url).searchParams.get('id') ?? '');
    if (!def) return ApiResponseBuilder.notFound('Email template');
    // Cleared rather than rewritten with the default: storing a copy of the
    // built-in wording means a later improvement to it never reaches this
    // install.
    await LocalDB.updateSetting(emailTemplateKey(def.id), null);
    return ApiResponseBuilder.success(
      { id: def.id, subject: def.defaultSubject, body: def.defaultBody },
      `${def.label} is back to the built-in wording`,
    );
  } catch (err) {
    console.error('Email template reset error:', err);
    return ApiResponseBuilder.serverError('Could not reset that email template');
  }
};
