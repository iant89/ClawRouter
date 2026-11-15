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
  if (!view?.quota || !view.usage) return null;
  return (
    <Card title="Your usage quota" subtitle={`${describeQuota(view.quota)} for all of your API keys together. ${describeReset(view.quota)}.`} headingLevel={2}>
      <QuotaUsageBar quota={view.quota} usage={view.usage} />
    </Card>
  );
}
