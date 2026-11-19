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
import type { ProviderState } from '@clawrouter/shared';

type Tone = NonNullable<StatusIndicatorProps['tone']>;
const TONE: Record<ProviderState, Tone> = { HEALTHY: 'success', DEGRADED: 'warning', OFFLINE: 'error', DISABLED: 'neutral', UNKNOWN: 'information' };
const LABEL: Record<ProviderState, string> = { HEALTHY: 'Healthy', DEGRADED: 'Degraded', OFFLINE: 'Offline', DISABLED: 'Disabled', UNKNOWN: 'Not checked' };

export const providerStateLabel = (s: ProviderState) => LABEL[s];

/** Provider state as text + icon (spec §18: never color alone). */
export function ProviderStatus({ state, ...rest }: { state: ProviderState } & Omit<StatusIndicatorProps, 'tone' | 'children'>) {
  return <StatusIndicator tone={TONE[state]} {...rest}>{LABEL[state]}</StatusIndicator>;
}
