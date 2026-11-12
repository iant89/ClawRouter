import { errors, v } from '@clawapi/core';
import type { AuthorizationService } from '@clawapi/authorization';
import type { RoleInfo, UserWithRoles } from '@clawapi/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { ok } from '../http/responses.ts';

const setRolesBody = v.object({
  roles: (value, path, issues) => {
    if (!Array.isArray(value) || value.length > 20 || !value.every((r) => typeof r === 'string' && r.length > 0 && r.length <= 64)) {
      issues.push({ path, message: 'must be a list of role ids' });
      return undefined;
    }
    return value as string[];
  },
});

function actor(ctx: RequestContext) {
  // The dispatcher guarantees a session on non-public routes.
  return { id: ctx.auth!.user.id, username: ctx.auth!.user.username };
}

/** Roles and role assignments (spec §16). */
export function accessController(authz: AuthorizationService) {
  const listRoles: Handler = () => ok<RoleInfo[]>(authz.listRoles());

  const listUsers: Handler = () => ok<UserWithRoles[]>(authz.listUsers());

  const setUserRoles: Handler = async (ctx) => {
    const body = await readJson(ctx, setRolesBody);
    const id = ctx.params.id;
    if (!id) throw errors.notFound();
    const user = authz.setUserRoles(actor(ctx), id, body.roles, { ip: ctx.ip, requestId: ctx.requestId });
    return ok<UserWithRoles>(user);
  };

  return { listRoles, listUsers, setUserRoles };
}
