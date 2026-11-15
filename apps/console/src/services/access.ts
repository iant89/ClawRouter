import type {
  CreateRoleRequest, CreateUserRequest, ResetPasswordRequest, RoleInfo, SetUserRolesRequest, UpdateRoleRequest, UpdateUserRequest, UserQuota, UserQuotaView, UserWithRoles,
} from '@clawrouter/shared';
import { apiDelete, apiGet, apiPost, apiPut, request } from './api-client.ts';

const enc = encodeURIComponent;

export const fetchRoles = (signal?: AbortSignal) => apiGet<RoleInfo[]>('/api/roles', { signal });
export const createRole = (body: CreateRoleRequest) => apiPost<RoleInfo>('/api/roles', body);
export const updateRole = (id: string, body: UpdateRoleRequest) => request<RoleInfo>('PATCH', `/api/roles/${enc(id)}`, body);
export const deleteRole = (id: string) => apiDelete(`/api/roles/${enc(id)}`);

export const fetchUsers = (signal?: AbortSignal) => apiGet<UserWithRoles[]>('/api/users', { signal });
export const createUser = (body: CreateUserRequest) => apiPost<UserWithRoles>('/api/users', body);
export const fetchUserQuota = (id: string, signal?: AbortSignal) => apiGet<UserQuotaView>(`/api/users/${enc(id)}/quota`, { signal });
export const putUserQuota = (id: string, quota: UserQuota | null) => request<UserQuotaView>('PUT', `/api/users/${enc(id)}/quota`, { quota });
export const fetchOwnQuota = (signal?: AbortSignal) => apiGet<UserQuotaView>('/api/auth/quota', { signal });
export const updateUser = (id: string, body: UpdateUserRequest) => request<UserWithRoles>('PATCH', `/api/users/${enc(id)}`, body);
export const resetPassword = (id: string, password: string) =>
  apiPost<UserWithRoles>(`/api/users/${enc(id)}/password`, { password } satisfies ResetPasswordRequest);
export const setUserRoles = (userId: string, roles: string[]) =>
  apiPut<UserWithRoles>(`/api/users/${enc(userId)}/roles`, { roles } satisfies SetUserRolesRequest);
