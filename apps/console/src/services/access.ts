import type { RoleInfo, SetUserRolesRequest, UserWithRoles } from '@clawapi/shared';
import { apiGet, apiPut } from './api-client.ts';

export const fetchRoles = (signal?: AbortSignal) => apiGet<RoleInfo[]>('/api/roles', { signal });
export const fetchUsers = (signal?: AbortSignal) => apiGet<UserWithRoles[]>('/api/users', { signal });
export const setUserRoles = (userId: string, roles: string[]) =>
  apiPut<UserWithRoles>(`/api/users/${encodeURIComponent(userId)}/roles`, { roles } satisfies SetUserRolesRequest);
