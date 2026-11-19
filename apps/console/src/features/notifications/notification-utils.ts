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

import type { NotificationInfo, NotificationSeverity } from '@clawrouter/shared';

export const SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  INFO: 'Info',
  SUCCESS: 'Resolved',
  WARNING: 'Warning',
  ERROR: 'Error',
};

/** Title with the severity in words, so it never depends on color (spec §18). */
export function displayTitle(n: Pick<NotificationInfo, 'severity' | 'title'>): string {
  return `${SEVERITY_LABEL[n.severity]}: ${n.title}`;
}

/** Unread warnings and errors not seen in the previous poll. */
export function newAlerts(items: NotificationInfo[], known: ReadonlySet<string>): NotificationInfo[] {
  return items.filter((n) => !known.has(n.id) && !n.read && (n.severity === 'WARNING' || n.severity === 'ERROR'));
}
