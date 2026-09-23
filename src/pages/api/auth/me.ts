import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { LocalDB } from '../../../lib/localdb';
import { toPublicUser, capabilityOverrides } from '../../../lib/auth';
import { effectiveCapabilities } from '../../../lib/capabilities';

// Returns the principal the current credential resolves to. Works for BOTH
// auth schemes: a cookie session (a real user row) and a bearer API key (a
// synthetic principal — the key isn't a user, but a headless/agent caller still
// needs to introspect its id + effective role). The `type` field discriminates.
export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return ApiResponseBuilder.unauthorized();

  // The EFFECTIVE capabilities of this principal (C-138), on both branches.
  //
  // Without them a client has to know the role table to predict what a call
  // will do — which is how an admin screen ends up rendering a button that
  // always 403s. The middleware has already resolved the operator's overrides
  // for this request, so this costs no read.
  const capabilities = effectiveCapabilities(user.role, capabilityOverrides());

  // Bearer API-key principal: id is "apikey:<id>", with no backing user row.
  if (user.id.startsWith('apikey:')) {
    return ApiResponseBuilder.success({ id: user.id, role: user.role, type: 'apikey', capabilities });
  }

  await LocalDB.init();
  const full = await LocalDB.getUser(user.id);
  if (!full) return ApiResponseBuilder.unauthorized();
  // Strip all server-only secrets (password hash/salt + the 2FA block); tag as
  // a user principal.
  return ApiResponseBuilder.success({ ...toPublicUser(full), type: 'user', capabilities });
};
