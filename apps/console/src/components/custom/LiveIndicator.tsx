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

import { StatusIndicator } from '@enterprise-ui/react';
import { useRealtimeState } from '../../features/realtime/RealtimeContext.tsx';
import type { RealtimeState } from '../../services/realtime.ts';

const STATE: Record<RealtimeState, { tone: 'success' | 'warning' | 'information' | 'neutral'; label: string; title: string }> = {
  live: { tone: 'success', label: 'Live', title: 'Pages update as things change.' },
  connecting: { tone: 'information', label: 'Connecting', title: 'Opening the live connection.' },
  reconnecting: { tone: 'warning', label: 'Reconnecting', title: 'The live connection was lost. Pages refresh periodically until it is back.' },
  offline: { tone: 'neutral', label: 'Offline', title: 'No live connection. Pages refresh periodically.' },
};

/** Header indicator for the console's live connection (text and icon, never color alone). */
export function LiveIndicator() {
  const s = STATE[useRealtimeState()];
  return <span title={s.title}><StatusIndicator tone={s.tone} size="sm">{s.label}</StatusIndicator></span>;
}
