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

import { EmptyState, Page } from '@enterprise-ui/react';
import type { NavItem } from '../../app/navigation.ts';

/**
 * Placeholder for a console page whose domain has not been built yet. It says
 * plainly that nothing is there instead of showing invented data.
 */
export function PlannedFeature({ item }: { item: NavItem }) {
  return (
    <Page title={item.label} subtitle={item.summary}>
      <EmptyState
        icon={item.icon}
        title={`${item.label} is not available yet`}
        description={`This area is delivered in roadmap phase ${item.plannedPhase}. The server API for it does not exist yet, so there is nothing to show.`}
      />
    </Page>
  );
}
