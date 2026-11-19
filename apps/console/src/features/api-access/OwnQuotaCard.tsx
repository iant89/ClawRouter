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

import { useEffect, useState } from 'react';
import { Card } from '@enterprise-ui/react';
import type { UserQuotaView } from '@clawrouter/shared';
import { fetchOwnQuota } from '../../services/access.ts';
import { describeQuota, describeReset, QuotaUsageBar } from '../users/QuotaFields.tsx';

/** The signed-in user's usage quota, when an administrator set one. Shows nothing otherwise. */
export function OwnQuotaCard({ refreshKey }: { refreshKey?: unknown }) {
  const [view, setView] = useState<UserQuotaView | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchOwnQuota(ctrl.signal).then(setView).catch(() => setView(null));
    return () => ctrl.abort();
  }, [refreshKey]);
  // Only a quota that can refuse requests is worth showing to its user.
  if (!view?.quota || !view.usage || !view.enforced) return null;
  return (
    <Card title="Your usage quota" subtitle={`${describeQuota(view.quota)} for all of your API keys together. ${describeReset(view.quota)}.`} headingLevel={2}>
      <QuotaUsageBar quota={view.quota} usage={view.usage} />
    </Card>
  );
}
