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
import { useRouter } from '../app/router.tsx';

export function NotFoundPage() {
  const { navigate } = useRouter();
  return (
    <Page title="Page not found">
      <EmptyState
        icon="search"
        title="This page does not exist"
        description="Check the address, or go back to the dashboard."
        actions={<Button onClick={() => navigate('/')}>Go to dashboard</Button>}
      />
    </Page>
  );
}
