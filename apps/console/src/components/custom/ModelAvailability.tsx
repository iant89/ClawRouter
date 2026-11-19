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
import type { ModelInfo } from '@clawrouter/shared';

/**
 * Whether a model can receive requests, and why not. Combines the model's own
 * availability with its provider's (spec §9), always as text.
 */
export function ModelAvailability({ model }: { model: Pick<ModelInfo, 'usable' | 'unusableReason' | 'availability'> }) {
  if (model.usable) {
    return model.availability === 'AVAILABLE'
      ? <StatusIndicator tone="success" size="sm">Usable</StatusIndicator>
      : <StatusIndicator tone="information" size="sm">Usable (not verified)</StatusIndicator>;
  }
  const tone = model.unusableReason?.includes('disabled') ? 'neutral' : 'warning';
  return <StatusIndicator tone={tone} size="sm">{model.unusableReason ?? 'Unusable'}</StatusIndicator>;
}
