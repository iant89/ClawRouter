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

import { Tag, Text } from '@enterprise-ui/react';

const SCHEME: Record<string, 1 | 6 | 8> = { ADMIN: 1, OPERATOR: 6, VIEWER: 8 };

/** Role ids as tags; text always carries the meaning (never color alone). */
export function RoleTags({ roles, names }: { roles: string[]; names?: Map<string, string> }) {
  if (roles.length === 0) return <Text tone="secondary">No role</Text>;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 'var(--eui-space-1, 0.25rem)' }}>
      {roles.map((r) => (
        <Tag key={r} colorScheme={SCHEME[r] ?? 8}>{names?.get(r) ?? r}</Tag>
      ))}
    </span>
  );
}
