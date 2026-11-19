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

import { PERMISSIONS, type BuiltInRoleId, type Permission } from '@clawrouter/shared';

/**
 * Permissions of the built-in roles (spec §16). Defined in code, not data, so a
 * permission added in a later phase reaches ADMIN automatically and the
 * built-ins cannot drift between installations.
 */
export const BUILT_IN_ROLE_PERMISSIONS: Record<BuiltInRoleId, readonly Permission[]> = {
  /** Full access. */
  ADMIN: PERMISSIONS,
  /** Providers, models, routing, rate limits, health, logs, audit, requests, usage. */
  OPERATOR: [
    'providers.read', 'providers.write',
    'models.read', 'models.write',
    'routing.read', 'routing.write',
    'rate_limits.read', 'rate_limits.write',
    'health.read',
    'logs.read',
    'audit.read',
    'requests.read',
    'usage.read',
    // Owner's decision (2026-11-13): Operators create their own API keys.
    'api_keys.own',
  ],
  /**
   * Read-only view of gateway configuration and activity. Deliberately excludes
   * logs and audit (they can reveal security-relevant detail) and everything
   * under Administration.
   */
  VIEWER: ['providers.read', 'models.read', 'routing.read', 'rate_limits.read', 'requests.read', 'usage.read', 'health.read'],
};

export function permissionsOfRole(roleId: string): readonly Permission[] {
  return (BUILT_IN_ROLE_PERMISSIONS as Record<string, readonly Permission[] | undefined>)[roleId] ?? [];
}
