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

import { Button } from '@enterprise-ui/react';
import { AuthPanel } from '../../components/custom/AuthPanel.tsx';
import { AccountSecurity } from './AccountSecurity.tsx';
import { useAuth } from './AuthContext.tsx';

/**
 * Shown instead of the console while an administrator requires two-factor
 * sign-in and the user has not set it up. The server refuses every other API
 * call (403 two_factor_setup_required) until a method is enabled.
 */
export function ForcedTwoFactorSetup() {
  const { state, signOut } = useAuth();
  const name = state.status === 'signed-in' ? state.session.user.displayName : '';
  return (
    <AuthPanel title="Set up two-factor sign-in" subtitle={`Welcome, ${name}`} wide>
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        <AccountSecurity />
        <div><Button variant="tertiary" onClick={() => void signOut()}>Sign out</Button></div>
      </div>
    </AuthPanel>
  );
}
