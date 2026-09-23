import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';
import { hashPassword } from '../../../lib/auth';
import { ROLES } from '../../../core/models';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const result = validate<{
      name: string;
      email: string;
      role: 'admin' | 'editor' | 'author' | 'viewer';
      password: string;
      status?: 'active' | 'inactive';
    }>(body, {
      name: { type: 'string', min: 1, max: 100 },
      email: { type: 'string', min: 3, max: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
      role: { type: 'enum', values: ROLES as unknown as string[] },
      password: { type: 'string', min: 8, max: 200 },
      status: { type: 'enum', values: ['active', 'inactive'], optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid user payload', result.errors);

    const exists = await LocalDB.getUserByEmail(result.value.email);
    if (exists) return ApiResponseBuilder.badRequest('Email already in use');

    const { hash, salt } = await hashPassword(result.value.password);
    const user = await LocalDB.createUser({
      name: result.value.name,
      email: result.value.email,
      role: result.value.role,
      status: result.value.status ?? 'active',
      password_hash: hash,
      password_salt: salt,
      posts_count: 0,
    });
    const { password_hash, password_salt, ...safe } = user as any;
    return ApiResponseBuilder.created(safe, 'User created successfully');
  } catch (err) {
    console.error('User create error:', err);
    return ApiResponseBuilder.serverError('Failed to create user');
  }
};
