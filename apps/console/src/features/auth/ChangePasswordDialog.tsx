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

import { Button, Dialog, Text, useToast } from '@enterprise-ui/react';
import { ChangePasswordForm } from './ChangePasswordForm.tsx';

/** User menu → Change password. Other sessions of this user end; this one stays signed in. */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  return (
    <Dialog open={open} onClose={onClose} title="Change password">
      {open && (
        <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
          <Text as="p" size="sm" tone="secondary">You stay signed in here; your other sessions are signed out.</Text>
          <ChangePasswordForm
            onChanged={() => {
              onClose();
              toast.show({ tone: 'success', title: 'Password changed', description: 'Your other sessions were signed out.' });
            }}
            extraActions={<Button variant="tertiary" onClick={onClose}>Cancel</Button>}
          />
        </div>
      )}
    </Dialog>
  );
}
