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

import type {
  MailServerSettings, RecoveryCodes, SignInSecuritySettings, TotpSetup, TwoFactorMethod, TwoFactorStatus, UpdateMailServerRequest, UpdateSignInSecurityRequest, UserSummary, UserWithRoles,
} from '@clawrouter/shared';
import { apiGet, apiPost, apiPut } from './api-client.ts';

// The signed-in user's two-factor sign-in. Secrets and recovery codes are kept in component state only.
export const fetchTwoFactor = (signal?: AbortSignal) => apiGet<TwoFactorStatus>('/api/auth/2fa', { signal });
export const startTotp = () => apiPost<TotpSetup>('/api/auth/2fa/totp');
export const confirmTotp = (code: string) => apiPost<RecoveryCodes>('/api/auth/2fa/totp/confirm', { code });
export const startEmailCodes = () => apiPost<{ sentTo: string }>('/api/auth/2fa/email');
export const confirmEmailCodes = (code: string) => apiPost<RecoveryCodes>('/api/auth/2fa/email/confirm', { code });
export const disableMethod = (method: TwoFactorMethod, password: string) => apiPost<TwoFactorStatus>('/api/auth/2fa/disable', { method, password });
export const newRecoveryCodes = (password: string) => apiPost<RecoveryCodes>('/api/auth/2fa/recovery-codes', { password });
export const changeMyEmail = (email: string | null, password: string) => apiPut<UserSummary>('/api/auth/email', { email, password });

// Administrator settings.
export const fetchSignInSettings = (signal?: AbortSignal) => apiGet<SignInSecuritySettings>('/api/settings/sign-in', { signal });
export const saveSignInSettings = (body: UpdateSignInSecurityRequest) => apiPut<SignInSecuritySettings>('/api/settings/sign-in', body);
export const fetchMailSettings = (signal?: AbortSignal) => apiGet<MailServerSettings>('/api/settings/mail', { signal });
export const saveMailSettings = (body: UpdateMailServerRequest) => apiPut<MailServerSettings>('/api/settings/mail', body);
export const sendTestMail = () => apiPost<{ sent: boolean; to?: string; reason?: string }>('/api/settings/mail/test');
export const resetUserTwoFactor = (userId: string) => apiPost<UserWithRoles>(`/api/users/${encodeURIComponent(userId)}/two-factor/reset`);
