import { errors, v } from '@clawrouter/core';
import type { AuthService, UserAdminService } from '@clawrouter/authentication';
import type { UserSummary, UserWithRoles } from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { created, ok } from '../http/responses.ts';

// Passwords are not trimmed; the upper bound stops hashing huge inputs. The policy is checked by the service.
const password = () => v.string({ min: 1, max: 1024, trim: false });

const roleList = (value: unknown, path: string, issues: { path: string; message: string }[]) => {
  if (!Array.isArray(value) || value.length > 20 || !value.every((r) => typeof r === 'string' && r.length > 0 && r.length <= 64)) {
    issues.push({ path, message: 'must be a list of role ids' });
    return undefined;
  }
  return value as string[];
};

/** An email address, null to remove it, or absent. The service checks the format. */
const optionalEmail = (value: unknown, path: string, issues: { path: string; message: string }[]) => {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' && value.length <= 254) return value;
  issues.push({ path, message: 'must be an email address or null' });
  return undefined;
};

const createBody = v.object({
  username: v.string({ min: 1, max: 64 }),
  displayName: v.string({ min: 1, max: 128 }),
  password: password(),
  roles: roleList,
  email: optionalEmail,
});

const updateBody = v.object({
  displayName: v.optional(v.string({ min: 1, max: 128 })),
  status: v.optional(v.oneOf(['ACTIVE', 'DISABLED'] as const)),
  email: optionalEmail,
});

const resetBody = v.object({ password: password() });

const changeBody = v.object({ currentPassword: password(), newPassword: password() });

const client = (ctx: RequestContext) => ({ ip: ctx.ip, userAgent: ctx.request.headers.get('user-agent'), requestId: ctx.requestId });

/** The acting user, with their permissions (nobody can grant or manage beyond their own). */
const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username, permissions: ctx.auth!.permissions as ReadonlySet<string> });

/** Console user administration (users.write) and changing one's own password. */
export function usersController(users: UserAdminService, auth: AuthService) {
  const create: Handler = async (ctx) => {
    const body = await readJson(ctx, createBody);
    const user = await users.create(actor(ctx), body, client(ctx));
    return created<UserWithRoles>(user, `/api/users/${user.id}`);
  };

  const update: Handler = async (ctx) => {
    const body = await readJson(ctx, updateBody);
    return ok<UserWithRoles>(users.update(actor(ctx), ctx.params.id ?? '', body, client(ctx)));
  };

  const resetPassword: Handler = async (ctx) => {
    const body = await readJson(ctx, resetBody);
    return ok<UserWithRoles>(await users.resetPassword(actor(ctx), ctx.params.id ?? '', body.password, client(ctx)));
  };

  /** 'authenticated': only ever the caller's own password. */
  const changeOwnPassword: Handler = async (ctx) => {
    if (!ctx.auth) throw errors.notFound();
    const body = await readJson(ctx, changeBody);
    return ok<UserSummary>(await auth.changePassword(ctx.auth.user.id, ctx.auth.sessionId, body.currentPassword, body.newPassword, client(ctx)));
  };

  /** POST /api/users/:id/two-factor/reset: removes a user's methods (lost phone). */
  const resetTwoFactor: Handler = (ctx) => ok<UserWithRoles>(users.resetTwoFactor(actor(ctx), ctx.params.id ?? '', client(ctx)));

  return { create, update, resetPassword, changeOwnPassword, resetTwoFactor };
}
