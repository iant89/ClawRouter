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

import { useEffect, useState } from 'react';
import { Button, Dialog, MessageStrip } from '@enterprise-ui/react';
import { PASSWORD_POLICY, type UserWithRoles } from '@clawrouter/shared';
import { resetPassword } from '../../services/access.ts';
import { ApiClientError } from '../../services/api-client.ts';
import { generatePassword, TemporaryPasswordField } from './TemporaryPasswordField.tsx';

/** Sets a temporary password for another user; they are signed out everywhere. */
export function ResetPasswordDialog({ user, onClose, onDone }: { user: UserWithRoles | null; onClose: () => void; onDone: (user: UserWithRoles) => void }) {
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    setPassword(generatePassword());
    setFieldError(undefined);
    setError(null);
  }, [user]);

  const save = async () => {
    if (!user) return;
    if (password.length < PASSWORD_POLICY.minLength) {
      setFieldError(`Use at least ${PASSWORD_POLICY.minLength} characters.`);
      return;
    }
    setSaving(true);
    setError(null);
    setFieldError(undefined);
    try {
      onDone(await resetPassword(user.id, password));
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) setFieldError(`This ${err.issues[0]!.message}.`);
      else setError(err instanceof Error ? err.message : 'Could not reset the password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={user !== null}
      onClose={onClose}
      title={user ? `Reset password for ${user.displayName}` : 'Reset password'}
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} loading={saving}>Reset password</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        <MessageStrip tone="warning">{user?.displayName} will be signed out everywhere and must choose a new password at the next sign-in.</MessageStrip>
        <TemporaryPasswordField value={password} onChange={setPassword} error={fieldError} />
      </div>
    </Dialog>
  );
}
