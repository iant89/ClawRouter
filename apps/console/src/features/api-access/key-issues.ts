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

import { ApiClientError } from '../../services/api-client.ts';

const FIELD: Record<string, string> = {
  name: 'Name', allowedModels: 'Allowed models', expiry: 'Expiry', expiresAt: 'Expiry', rateLimit: 'Rate limit', purpose: 'Purpose', note: 'Note', reason: 'Reason',
};

/** "Expiry must be at most 7 days from now: …" from the server's field issues, for key dialogs. */
export function describeKeyError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.issues.length) {
    return err.issues.map((i) => `${FIELD[i.path.split('.')[0]!] ?? i.path} ${i.message}.`).join(' ');
  }
  return err instanceof Error ? err.message : fallback;
}
