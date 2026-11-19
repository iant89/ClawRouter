/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

import { errors, v } from '@clawrouter/core';
import type { AuthorizationService } from '@clawrouter/authorization';
import type { CreateRoleRequest, Permission, RoleInfo, UpdateRoleRequest, UserWithRoles } from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { created, noContent, ok } from '../http/responses.ts';

const setRolesBody = v.object({
  roles: (value, path, issues) => {
    if (!Array.isArray(value) || value.length > 20 || !value.every((r) => typeof r === 'string' && r.length > 0 && r.length <= 64)) {
      issues.push({ path, message: 'must be a list of role ids' });
      return undefined;
    }
    return value as string[];
  },
});

/** Shape only: the authorization service checks names, permissions and the owner's rules. */
const permissionList = (value: unknown, path: string, issues: { path: string; message: string }[]) => {
  if (!Array.isArray(value) || value.length > 100 || !value.every((p) => typeof p === 'string' && p.length <= 64)) {
    issues.push({ path, message: 'must be a list of permissions' });
    return undefined;
  }
  return value as Permission[];
};

const createRoleBody = v.object({
  name: v.string({ min: 1, max: 64 }),
  description: v.optional(v.string({ max: 300 })),
  permissions: permissionList,
});

const updateRoleBody = v.object({
  name: v.optional(v.string({ min: 1, max: 64 })),
  description: v.optional(v.string({ max: 300 })),
  permissions: v.optional(permissionList),
});

function actor(ctx: RequestContext) {
  // The dispatcher guarantees a session on non-public routes.
  // Permissions travel with the actor: nobody can grant what they do not hold.
  return { id: ctx.auth!.user.id, username: ctx.auth!.user.username, permissions: ctx.auth!.permissions as ReadonlySet<string> };
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

  const createRole: Handler = async (ctx) => {
    const body = await readJson(ctx, createRoleBody);
    const role = authz.createRole(actor(ctx), body as CreateRoleRequest, { ip: ctx.ip, requestId: ctx.requestId });
    return created<RoleInfo>(role, `/api/roles/${role.id}`);
  };

  const updateRole: Handler = async (ctx) => {
    const body = await readJson(ctx, updateRoleBody);
    return ok<RoleInfo>(authz.updateRole(actor(ctx), ctx.params.id ?? '', body as UpdateRoleRequest, { ip: ctx.ip, requestId: ctx.requestId }));
  };

  const deleteRole: Handler = (ctx) => {
    authz.deleteRole(actor(ctx), ctx.params.id ?? '', { ip: ctx.ip, requestId: ctx.requestId });
    return noContent();
  };

  return { listRoles, listUsers, setUserRoles, createRole, updateRole, deleteRole };
}
