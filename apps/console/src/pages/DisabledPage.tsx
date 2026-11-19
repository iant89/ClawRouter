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
import { Button, EmptyState, Page } from '@enterprise-ui/react';
import type { NavItem } from '../app/navigation.ts';
import { useRouter } from '../app/router.tsx';

/**
 * Shown when a page an administrator turned off in Settings is opened directly (a bookmark,
 * a link). The menu does not show it; its API answers 403 with reason `feature_disabled`.
 */
export function DisabledPage({ item }: { item: NavItem }) {
  const { navigate } = useRouter();
  return (
    <Page title={item.label}>
      <EmptyState
        icon="decline"
        title={`The ${item.label.toLowerCase()} has been disabled`}
        description="An administrator turned it off for everyone in Settings. Ask them if you need it."
        actions={<Button onClick={() => navigate('/')}>Go to dashboard</Button>}
      />
    </Page>
  );
}
