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

import type { HealthComponent, HealthState } from '@clawrouter/shared';

export interface HealthProbeResult {
  status: HealthState;
  /** Short, display-safe detail. Never include secrets, paths to credentials or raw errors. */
  detail?: string;
}

/** A single health probe. Implementations live next to what they check. */
export interface HealthCheck {
  component: HealthComponent;
  /** An OFFLINE critical check makes the whole platform OFFLINE. */
  critical: boolean;
  check(): Promise<HealthProbeResult> | HealthProbeResult;
}
