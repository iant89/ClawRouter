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

import { StatusIndicator, type StatusIndicatorProps } from '@enterprise-ui/react';
import type { HealthState } from '@clawrouter/shared';

type Tone = NonNullable<StatusIndicatorProps['tone']>;

/** Spec §18: green healthy, orange warning, red offline, blue informational. */
export const HEALTH_TONE: Record<HealthState, Tone> = {
  HEALTHY: 'success',
  DEGRADED: 'warning',
  OFFLINE: 'error',
  DISABLED: 'neutral',
  UNKNOWN: 'information',
};

export const HEALTH_LABEL: Record<HealthState, string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  OFFLINE: 'Offline',
  DISABLED: 'Disabled',
  UNKNOWN: 'Unknown',
};

export interface HealthStateIndicatorProps extends Omit<StatusIndicatorProps, 'tone' | 'children'> {
  state: HealthState;
  /** Optional prefix, e.g. "Gateway" renders "Gateway: Healthy". */
  label?: string;
}

/**
 * Health state as text plus icon (never color alone). Composition of the
 * ENTERPRISE-UI StatusIndicator; kept in the app because the state vocabulary
 * is ClawRouter-specific.
 */
export function HealthStateIndicator({ state, label, ...rest }: HealthStateIndicatorProps) {
  return (
    <StatusIndicator tone={HEALTH_TONE[state]} {...rest}>
      {label ? `${label}: ${HEALTH_LABEL[state]}` : HEALTH_LABEL[state]}
    </StatusIndicator>
  );
}
