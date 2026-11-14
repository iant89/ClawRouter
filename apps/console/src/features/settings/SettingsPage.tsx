import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Input, MessageStrip, Page, RefreshControl, StatusIndicator, Tab, TabList, TabPanel, Tabs, Text, useToast } from '@enterprise-ui/react';
import { useRouter } from '../../app/router.tsx';
import { FieldHelp } from '../../components/custom/FieldHelp.tsx';
import type { MailServerSettings, SettingInfo, SettingKey } from '@clawrouter/shared';
import { useResource } from '../../hooks/useResource.ts';
import { ApiClientError } from '../../services/api-client.ts';
import { fetchSettings, saveSettings } from '../../services/settings.ts';
import { usePermissions } from '../auth/AuthContext.tsx';
import { useRealtimeEvent } from '../realtime/RealtimeContext.tsx';
import { KeysBeyondLifetime } from './KeysBeyondLifetime.tsx';
import { ConfigurationTransfer } from './ConfigurationTransfer.tsx';
import { MailServerCard, TwoFactorPolicyCard } from './SignInSecuritySettings.tsx';

/** Draft values as typed (strings), keyed by setting. */
type Draft = Partial<Record<SettingKey, string>>;

/** Under the field: only what is needed to type a valid value. */
const describeRange = (s: SettingInfo) => `Allowed ${s.min}–${s.max}. Default ${s.defaultValue}.`;
/** In the field's help tip: what it does, and where the default comes from. */
const settingHelp = (s: SettingInfo) => (
  <>
    <span>{s.description}</span>
    <span className="claw-field-help-note">
      Default {s.defaultValue} {s.unit}{s.env ? <>, from <span className="claw-mono">{s.env}</span> when set, otherwise built in</> : ', built in'}.
    </span>
  </>
);

/** The tabs, in order, and which groups of numeric settings each one shows. */
const TABS = [
  { value: 'security', label: 'Sign-in and sessions', groups: ['Security'] },
  { value: 'api-keys', label: 'API keys', groups: ['API keys'] },
  { value: 'mail', label: 'Mail server', groups: [] },
  { value: 'retention', label: 'Data retention', groups: ['Data retention'] },
  { value: 'configuration', label: 'Import and export', groups: [] },
] as const;
/** Card titles where the group name would only repeat the tab. */
const GROUP_TITLE: Record<string, string> = { Security: 'Sessions and failed sign-ins' };
type TabValue = (typeof TABS)[number]['value'];
const isTab = (v: string | null): v is TabValue => TABS.some((t) => t.value === v);
/** A group no tab names (a setting added later) shows on the first tab rather than nowhere. */
const tabOfGroup = (group: string): TabValue => TABS.find((t) => (t.groups as readonly string[]).includes(group))?.value ?? TABS[0].value;

/**
 * Administration → Settings (spec §16), in tabs: sign-in and sessions (with the
 * two-factor policy), API keys, mail server, data retention, and configuration
 * import/export. Values changed here take precedence over the environment and
 * apply without a restart. The server validates every value. The selected tab is
 * in the URL (`?tab=`), and hidden tabs stay mounted so unsaved edits survive a
 * switch; each tab saves only its own changes.
 */
export function SettingsPage() {
  const toast = useToast();
  const { search, navigate } = useRouter();
  const requested = new URLSearchParams(search).get('tab');
  const tab: TabValue = isTab(requested) ? requested : TABS[0].value;
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

  // Maximum key lifetime: list the keys that outlast the value being typed (or the saved one).
  const keyLimit = useMemo(() => {
    const saved = data?.find((s) => s.key === 'keyMaxLifetimeDays');
    if (!saved) return null;
    const typed = Number(draft.keyMaxLifetimeDays);
    const valid = draft.keyMaxLifetimeDays?.trim() && Number.isInteger(typed) && typed >= saved.min && typed <= saved.max;
    const days = valid ? typed : saved.value;
    return { days, lowering: days < saved.value };
  }, [data, draft.keyMaxLifetimeDays]);

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

  const changedIn = (t: TabValue) => changed.filter((s) => tabOfGroup(s.group) === t);

  const save = (t: TabValue) => {
    const local: Partial<Record<SettingKey, string>> = {};
    const values: Partial<Record<SettingKey, number>> = {};
    const mine = changedIn(t);
    for (const s of mine) {
      const n = Number(draft[s.key]);
      if (draft[s.key]!.trim() === '' || !Number.isInteger(n) || n < s.min || n > s.max) local[s.key] = `Enter a whole number from ${s.min} to ${s.max}.`;
      else values[s.key] = n;
    }
    setFieldErrors(local);
    if (Object.keys(local).length) return;
    void submit(values, mine.map((s) => s.label).join(', '));
  };

  const discard = (t: TabValue) =>
    setDraft((d) => ({ ...d, ...Object.fromEntries(changedIn(t).map((s) => [s.key, String(s.value)])) }));

  /** The numeric settings of one tab: a card per group; the last card holds the tab's save bar. */
  const numericSettings = (t: TabValue) => {
    const mine = groups.filter(([group]) => tabOfGroup(group) === t);
    if (!mine.length) return null;
    const pending = changedIn(t);
    const elsewhere = TABS.filter((o) => o.value !== t && changedIn(o.value).length);
    return (
      <>
        {mine.map(([group, settings], index) => (
          <Card key={group} title={GROUP_TITLE[group] ?? group} headingLevel={2}>
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
                    description={describeRange(s)}
                    endAdornment={<FieldHelp label={s.label}>{settingHelp(s)}</FieldHelp>}
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
            {settings.some((s) => s.key === 'keyMaxLifetimeDays') && can('api_keys.read') && keyLimit && <KeysBeyondLifetime {...keyLimit} />}
            {canWrite && index === mine.length - 1 && (
              <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'center', flexWrap: 'wrap', marginBlockStart: 'var(--eui-space-4, 1rem)' }}>
                <Button variant="primary" onClick={() => save(t)} loading={saving} disabled={!pending.length}>Save changes</Button>
                <Button variant="tertiary" disabled={!pending.length || saving} onClick={() => discard(t)}>Discard</Button>
                <Text size="sm" tone="secondary" role="status">
                  {pending.length ? `${pending.length} unsaved change${pending.length === 1 ? '' : 's'}` : 'No unsaved changes'}
                  {elsewhere.length ? `. Also unsaved: ${elsewhere.map((o) => o.label).join(', ')}.` : ''}
                </Text>
              </div>
            )}
          </Card>
        ))}
      </>
    );
  };

  const panel = { display: 'grid', gap: 'var(--eui-space-4, 1rem)' } as const;

  return (
    <Page
      title="Settings"
      subtitle="Sign-in, API keys, mail, data retention and configuration transfer. Changes apply without a restart and are recorded in the audit log."
      actions={<RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />}
    >
      {error && <MessageStrip tone="error" title="Cannot load settings">{error}</MessageStrip>}
      {!canWrite && data && <MessageStrip tone="information">You can view these settings. Changing them needs the settings.write permission.</MessageStrip>}
      <Tabs value={tab} onValueChange={(t) => navigate(t === TABS[0].value ? '/settings' : `/settings?tab=${t}`, { replace: true })}>
        <TabList aria-label="Settings">
          {TABS.map((t) => <Tab key={t.value} value={t.value}>{t.label}</Tab>)}
        </TabList>
        <TabPanel value="security" keepMounted>
          <div style={panel}>
            {numericSettings('security')}
            <TwoFactorPolicyCard canWrite={canWrite} mailConfigured={mailConfigured} />
          </div>
        </TabPanel>
        <TabPanel value="api-keys" keepMounted><div style={panel}>{numericSettings('api-keys')}</div></TabPanel>
        <TabPanel value="mail" keepMounted><div style={panel}><MailServerCard canWrite={canWrite} onLoaded={mailLoaded} /></div></TabPanel>
        <TabPanel value="retention" keepMounted><div style={panel}>{numericSettings('retention')}</div></TabPanel>
        <TabPanel value="configuration" keepMounted><div style={panel}><ConfigurationTransfer canImport={canWrite} /></div></TabPanel>
      </Tabs>
    </Page>
  );
}
