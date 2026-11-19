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

import { KEY_EXPIRY_MAX_HOURS } from '@clawrouter/shared';
import type { Validator } from '@clawrouter/core';

/**
 * Maximum API key lifetime in hours for providers and models: absent leaves it
 * unchanged, null removes the limit. Ranges are checked again by the services.
 */
export const keyLifetimeHours: Validator<number | null | undefined> = (value, path, issues) => {
  if (value === undefined || value === null) return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= KEY_EXPIRY_MAX_HOURS) return value;
  issues.push({ path, message: `must be a whole number of hours from 1 to ${KEY_EXPIRY_MAX_HOURS}, or null for no limit` });
  return undefined;
};
