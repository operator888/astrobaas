import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../lib/api-response';
import {
  type CaptchaSurface, captchaEnabledFor, makeChallenge, isCaptchaSurface,
} from '../../../lib/captcha';

/**
 * Hand out a proof-of-work challenge for one protected surface.
 *
 * Public and anonymous by nature — the whole point is that the ANONYMOUS
 * visitor solves it before submitting. Issuing is cheap (one HMAC) and sits
 * behind the standard per-IP API rate limit, so hoarding challenges buys an
 * attacker nothing: each is single-use, ten-minutes-mortal, and still costs
 * the full hash search to solve.
 *
 * `enabled:false` is a real answer, not an error: the widget asks, learns
 * the surface is unprotected, and stays out of the way. That keeps the
 * include-one-script contract on every form regardless of settings.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const surface = String(url.searchParams.get('surface') ?? '');
  // Toggleable surfaces AND the always-on ones (`reviews`): a surface whose
  // check can never be off must still be one a widget can get a challenge for.
  if (!isCaptchaSurface(surface)) {
    return ApiResponseBuilder.badRequest('Unknown captcha surface');
  }
  if (!(await captchaEnabledFor(surface as CaptchaSurface))) {
    return ApiResponseBuilder.success({ enabled: false });
  }
  const { token, bits } = makeChallenge(surface as CaptchaSurface);
  const res = ApiResponseBuilder.success({ enabled: true, token, bits });
  // A cached challenge is a shared challenge; single-use makes that a footgun.
  res.headers.set('Cache-Control', 'no-store');
  return res;
};
