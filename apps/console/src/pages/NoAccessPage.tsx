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

/** Shown when a page is opened directly without its permission. Not a security boundary: the API refuses too. */
export function NoAccessPage({ item }: { item: NavItem }) {
  const { navigate } = useRouter();
  return (
    <Page title={item.label}>
      <EmptyState
        icon="locked"
        title="You do not have access to this page"
        description={`It requires the "${item.permission}" permission. Ask an administrator to assign you a role that includes it.`}
        actions={<Button onClick={() => navigate('/')}>Go to dashboard</Button>}
      />
    </Page>
  );
}
