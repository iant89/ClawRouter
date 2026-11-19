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

import { Button, Text } from '@enterprise-ui/react';
import { AuthPanel } from '../../components/custom/AuthPanel.tsx';
import { useAuth } from './AuthContext.tsx';
import { ChangePasswordForm } from './ChangePasswordForm.tsx';

/**
 * Shown instead of the console while the user has a temporary password (a new
 * account or an administrator reset). The server refuses every other API call
 * until it is changed, so this is the only way forward.
 */
export function ForcedPasswordChange() {
  const { state, refresh, signOut } = useAuth();
  const name = state.status === 'signed-in' ? state.session.user.displayName : '';
  return (
    <AuthPanel title="Choose a new password" subtitle={`Welcome, ${name}`}>
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        <Text as="p">You signed in with a temporary password. Choose your own password to continue.</Text>
        <ChangePasswordForm
          currentLabel="Temporary password"
          submitLabel="Save and continue"
          onChanged={() => void refresh()}
          extraActions={<Button variant="tertiary" onClick={() => void signOut()}>Sign out</Button>}
        />
      </div>
    </AuthPanel>
  );
}
