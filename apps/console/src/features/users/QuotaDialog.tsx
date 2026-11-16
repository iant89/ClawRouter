import { useEffect, useState } from 'react';
import { BusyIndicator, Button, Dialog, MessageStrip } from '@enterprise-ui/react';
import type { UserQuota, UserQuotaView, UserWithRoles } from '@clawrouter/shared';
import { fetchUserQuota, putUserQuota } from '../../services/access.ts';
import { ApiClientError } from '../../services/api-client.ts';
import { QuotaFields, quotaErrors, QuotaUsageBar, type QuotaErrors } from './QuotaFields.tsx';

/** Shows where a user stands against their quota, and sets, changes or removes it. */
export function QuotaDialog({ user, onClose, onSaved }: {
  user: UserWithRoles | null;
  onClose: () => void;
  onSaved: (user: UserWithRoles, view: UserQuotaView) => void;
}) {
  const [view, setView] = useState<UserQuotaView | null>(null);
  const [draft, setDraft] = useState<UserQuota | null>(null);
  const [errors, setErrors] = useState<QuotaErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    const ctrl = new AbortController();
    setView(null);
    setErrors({});
    setError(null);
    fetchUserQuota(user.id, ctrl.signal)
      .then((v) => {
        setView(v);
        setDraft(v.quota);
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load the quota.');
      });
    return () => ctrl.abort();
  }, [user]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    setErrors({});
    setError(null);
    try {
      onSaved(user, await putUserQuota(user.id, draft));
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.some((i) => i.path.startsWith('quota.'))) setErrors(quotaErrors(err.issues));
      else setError(err instanceof Error ? err.message : 'Could not save the quota.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={user !== null} onClose={onClose} title={user ? `Usage quota for ${user.displayName}` : 'Usage quota'}
      footer={
        <>
          <Button variant="primary" loading={saving} disabled={!view} onClick={() => void save()}>Save</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <div style={{ display: 'grid', gap: 'var(--eui-space-4, 1rem)' }}>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        {!view && !error && <BusyIndicator text="Loading the quota" />}
        {view && !view.quotasEnabled && (
          <MessageStrip tone="information">User quotas are turned off for everyone (Settings → API keys and quotas). This quota is kept but nothing is refused.</MessageStrip>
        )}
        {view?.quota && view.usage && <QuotaUsageBar quota={view.quota} usage={view.usage} enforced={view.enforced} />}
        {view && <QuotaFields value={draft} onChange={setDraft} errors={errors} />}
      </div>
    </Dialog>
  );
}
