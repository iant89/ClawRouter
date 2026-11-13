import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Input, MessageStrip, Page, RefreshControl, StatusIndicator, Text, useToast } from '@enterprise-ui/react';
import type { MailServerSettings, SettingInfo, SettingKey } from '@clawrouter/shared';
import { useResource } from '../../hooks/useResource.ts';
import { ApiClientError } from '../../services/api-client.ts';
import { fetchSettings, saveSettings } from '../../services/settings.ts';
import { usePermissions } from '../auth/AuthContext.tsx';
import { useRealtimeEvent } from '../realtime/RealtimeContext.tsx';
import { MailServerCard, TwoFactorPolicyCard } from './SignInSecuritySettings.tsx';

/** Draft values as typed (strings), keyed by setting. */
type Draft = Partial<Record<SettingKey, string>>;

const describeDefault = (s: SettingInfo) =>
  `Default ${s.defaultValue} ${s.unit}${s.env ? ` (from ${s.env} or built in)` : ' (built in)'}. Allowed ${s.min}–${s.max}.`;

/**
 * Administration → Settings (spec §16): session lifetimes, sign-in throttling and
 * retention. Values changed here take precedence over the environment and apply
 * without a restart. The server validates every value.
 */
export function SettingsPage() {
  const toast = useToast();
  const { can } = usePermissions();
  const canWrite = can('settings.write');
  const { data, error, loading, lastUpdated, reload } = useResource(fetchSettings);
  const [draft, setDraft] = useState<Draft>({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SettingKey, string>>>({});
  const [saving, setSaving] = useState(false);
  const [mailConfigured, setMailConfigured] = useState<boolean>();
  const mailLoaded = useCallback((s: MailServerSettings) => setMailConfigured(s.configured), []);
  useRealtimeEvent(['settings.changed'], () => reload(), 300);

  // Start from the server's values whenever they change (and nothing is being edited).
  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.map((s) => [s.key, String(s.value)])) as Draft);
  }, [data]);

  const groups = useMemo(() => {
    const out = new Map<string, SettingInfo[]>();
    for (const s of data ?? []) out.set(s.group, [...(out.get(s.group) ?? []), s]);
    return [...out];
  }, [data]);

  const changed = (data ?? []).filter((s) => draft[s.key] !== undefined && draft[s.key] !== String(s.value));

  const submit = async (values: Partial<Record<SettingKey, number | null>>, message: string) => {
    setSaving(true);
    setFieldErrors({});
    try {
      await saveSettings(values);
      toast.show({ tone: 'success', title: 'Settings saved', description: message });
      reload();
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) {
        setFieldErrors(Object.fromEntries(err.issues.map((i) => [i.path.replace(/^values\./, ''), `This ${i.message}.`])));
      } else {
        toast.show({ tone: 'error', title: 'Cannot save settings', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
      }
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const local: Partial<Record<SettingKey, string>> = {};
    const values: Partial<Record<SettingKey, number>> = {};
    for (const s of changed) {
      const n = Number(draft[s.key]);
      if (draft[s.key]!.trim() === '' || !Number.isInteger(n) || n < s.min || n > s.max) local[s.key] = `Enter a whole number from ${s.min} to ${s.max}.`;
      else values[s.key] = n;
    }
    setFieldErrors(local);
    if (Object.keys(local).length) return;
    void submit(values, changed.map((s) => s.label).join(', '));
  };

  return (
    <Page
      title="Settings"
      subtitle="Security, sign-in and data retention. Changes apply without a restart and are recorded in the audit log."
      actions={<RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />}
    >
      {error && <MessageStrip tone="error" title="Cannot load settings">{error}</MessageStrip>}
      {!canWrite && data && <MessageStrip tone="information">You can view these settings. Changing them needs the settings.write permission.</MessageStrip>}
      {groups.map(([group, settings]) => (
        <Card key={group} title={group} headingLevel={2}>
          <div className="claw-settings-grid">
            {settings.map((s) => (
              <div key={s.key} style={{ display: 'grid', gap: 'var(--eui-space-1, 0.25rem)', alignContent: 'start' }}>
                <Input
                  label={`${s.label} (${s.unit})`}
                  type="number"
                  inputMode="numeric"
                  min={s.min}
                  max={s.max}
                  step={1}
                  readOnly={!canWrite}
                  value={draft[s.key] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                  error={fieldErrors[s.key]}
                  description={`${s.description} ${describeDefault(s)}`}
                />
                <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'center', flexWrap: 'wrap' }}>
                  {s.overridden
                    ? <StatusIndicator tone="information" size="sm">Changed in the console</StatusIndicator>
                    : <StatusIndicator tone="neutral" size="sm">Default</StatusIndicator>}
                  {s.overridden && canWrite && (
                    <Button size="sm" variant="tertiary" disabled={saving} onClick={() => void submit({ [s.key]: null }, `${s.label} reset to ${s.defaultValue} ${s.unit}`)}>
                      Reset to default
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
      {canWrite && data && (
        <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={save} loading={saving} disabled={!changed.length}>Save changes</Button>
          <Button variant="tertiary" disabled={!changed.length || saving} onClick={() => setDraft(Object.fromEntries(data.map((s) => [s.key, String(s.value)])) as Draft)}>Discard</Button>
          <Text size="sm" tone="secondary" role="status">{changed.length ? `${changed.length} unsaved change${changed.length === 1 ? '' : 's'}` : 'No unsaved changes'}</Text>
        </div>
      )}
      <TwoFactorPolicyCard canWrite={canWrite} mailConfigured={mailConfigured} />
      <MailServerCard canWrite={canWrite} onLoaded={mailLoaded} />
    </Page>
  );
}
