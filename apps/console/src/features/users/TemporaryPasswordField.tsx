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

import { Button, PasswordInput, WithFieldHelp } from '@enterprise-ui/react';
import { PASSWORD_POLICY } from '@clawrouter/shared';

/** A readable random password (about 100 bits): five groups of five, no look-alike characters. */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return ([...bytes].map((b) => alphabet[b % alphabet.length]).join('').match(/.{5}/g) ?? []).join('-');
}

/**
 * A temporary password chosen by an administrator. The user must replace it at
 * their next sign-in. Pass it on through a trusted channel; ClawRouter never shows it again.
 */
export function TemporaryPasswordField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error?: string }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-1, 0.25rem)' }}>
      <WithFieldHelp label="Temporary password" help="The user must choose their own password when they sign in with it. Pass it on in person or through a trusted channel: ClawRouter never shows it again.">
        <PasswordInput
          id="temp-password" label="Temporary password" purpose="new" autoComplete="new-password" required value={value}
          onChange={(e) => onChange(e.target.value)} error={error}
          requirements={[{ label: `At least ${PASSWORD_POLICY.minLength} characters`, test: (p) => p.length >= PASSWORD_POLICY.minLength }]}
        />
      </WithFieldHelp>
      <div>
        <Button size="sm" variant="secondary" icon="refresh" onClick={() => onChange(generatePassword())}>Generate</Button>
      </div>
    </div>
  );
}
