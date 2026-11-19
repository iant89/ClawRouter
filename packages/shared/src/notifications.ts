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

/** Console notifications (spec §17 header, §25 `notification.created`). */
export const NOTIFICATION_SEVERITIES = ['INFO', 'SUCCESS', 'WARNING', 'ERROR'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export interface NotificationInfo {
  id: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  /** Console path with more detail, e.g. `/health`. */
  link: string | null;
  /** What produced it, e.g. `health.changed`. */
  source: string;
  createdAt: string;
  read: boolean;
}

/** GET /api/notifications meta */
export interface NotificationMeta {
  unread: number;
}
