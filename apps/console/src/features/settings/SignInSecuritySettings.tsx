import { useEffect, useState } from 'react';
import { Button, Card, Checkbox, Input, MessageStrip, NumberInput, PasswordInput, Select, StatusIndicator, Switch, Text, useToast } from '@enterprise-ui/react';
import type { MailSecurity, MailServerSettings, SignInSecuritySettings as Policy, TwoFactorRequirement, UpdateMailServerRequest } from '@clawrouter/shared';
import { useResource } from '../../hooks/useResource.ts';
import { ApiClientError } from '../../services/api-client.ts';
import { fetchMailSettings, fetchSignInSettings, saveMailSettings, saveSignInSettings, sendTestMail } from '../../services/two-factor.ts';
import { useRealtimeEvent } from '../realtime/RealtimeContext.tsx';

const REQUIRE: { value: TwoFactorRequirement; label: string; description: string }[] = [
  { value: 'off', label: 'Optional', description: 'Users choose whether to set it up.' },
  { value: 'administrators', label: 'Required for administrators', description: 'Users with the Administrator role must set it up before anything else.' },
  { value: 'everyone', label: 'Required for everyone', description: 'Every user must set it up before anything else.' },
];

const SECURITY: { value: MailSecurity; label: string; port: number }[] = [
  { value: 'starttls', label: 'STARTTLS (usually port 587)', port: 587 },
  { value: 'tls', label: 'TLS from the start (usually port 465)', port: 465 },
  { value: 'none', label: 'None: plain text (only on a trusted network)', port: 25 },
];

const failure = (err: unknown) => (err instanceof Error ? err.message : undefined);

/** Administration → Settings: which two-factor methods are allowed, and who must use one. */
export function TwoFactorPolicyCard({ canWrite, mailConfigured }: { canWrite: boolean; mailConfigured: boolean | undefined }) {
  const toast = useToast();
  const { data, error, reload } = useResource(fetchSignInSettings);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  useRealtimeEvent(['settings.changed'], () => reload(), 300);
  useEffect(() => { if (data) setDraft(data); }, [data]);

  if (error) return <MessageStrip tone="error" title="Cannot load two-factor settings">{error}</MessageStrip>;
  if (!draft || !data) return null;
  const dirty = JSON.stringify([draft.methods, draft.require]) !== JSON.stringify([data.methods, data.require]);
  const noMethod = !draft.methods.totp && !draft.methods.email;

  const save = async () => {
    if (draft.require !== 'off' && noMethod) return setFormError('Allow at least one method before requiring two-factor sign-in.');
    setSaving(true);
    setFormError(null);
    try {
      await saveSignInSettings({ methods: draft.methods, require: draft.require });
      toast.show({ tone: 'success', title: 'Two-factor settings saved' });
      reload();
    } catch (err) {
      setFormError(err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => i.message).join(' ') : failure(err) ?? 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Two-factor sign-in" subtitle="A second step after the password. Users set it up under the user menu → Sign-in security." headingLevel={2}>
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)', maxWidth: '40rem' }}>
        {formError && <MessageStrip tone="error" announce="assertive">{formError}</MessageStrip>}
        <fieldset className="claw-fieldset">
          <legend><Text size="sm">Allowed methods</Text></legend>
          <Checkbox
            label="Authenticator app"
            description="Time-based codes (TOTP) from an app such as 1Password, Google Authenticator or Microsoft Authenticator."
            checked={draft.methods.totp}
            disabled={!canWrite}
            onChange={(on) => setDraft({ ...draft, methods: { ...draft.methods, totp: on } })}
          />
          <Checkbox
            label="Codes by email"
            description={mailConfigured === false ? 'Needs a mail server (Mail server tab). Until it is set up, nobody can receive codes.' : 'A code is sent to the user’s email address at each sign-in.'}
            checked={draft.methods.email}
            disabled={!canWrite}
            onChange={(on) => setDraft({ ...draft, methods: { ...draft.methods, email: on } })}
          />
        </fieldset>
        <Select
          label="Who must use it"
          value={draft.require}
          disabled={!canWrite}
          onChange={(v) => v && setDraft({ ...draft, require: v as TwoFactorRequirement })}
          options={REQUIRE}
        />
        {draft.require !== 'off' && (
          <Text size="sm" tone="secondary">
            Users without it are asked to set it up at their next sign-in and can do nothing else until they have. Turning a method off later stops it from being used at sign-in; users who only had that method are asked to set up another.
          </Text>
        )}
        {canWrite && (
          <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>Save two-factor settings</Button>
            <Button variant="tertiary" onClick={() => setDraft(data)} disabled={!dirty || saving}>Discard</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

interface MailDraft { enabled: boolean; host: string; port: number | null; security: MailSecurity; username: string; password: string; from: string }

const toDraft = (s: MailServerSettings): MailDraft => ({ enabled: s.enabled, host: s.host, port: s.port, security: s.security, username: s.username ?? '', password: '', from: s.from });

/** Administration → Settings: the outgoing mail server for emailed sign-in codes. The password is write-only. */
export function MailServerCard({ canWrite, onLoaded }: { canWrite: boolean; onLoaded?: (s: MailServerSettings) => void }) {
  const toast = useToast();
  const { data, error, reload } = useResource(fetchMailSettings);
  const [draft, setDraft] = useState<MailDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removePassword, setRemovePassword] = useState(false);
  useRealtimeEvent(['settings.changed'], () => reload(), 300);
  useEffect(() => {
    if (!data) return;
    setDraft(toDraft(data));
    setRemovePassword(false);
    onLoaded?.(data);
  }, [data, onLoaded]);

  if (error) return <MessageStrip tone="error" title="Cannot load the mail server settings">{error}</MessageStrip>;
  if (!draft || !data) return null;
  const set = <K extends keyof MailDraft>(k: K, v: MailDraft[K]) => setDraft({ ...draft, [k]: v });
  const base = toDraft(data);
  const dirty = removePassword || draft.password !== '' || (['enabled', 'host', 'port', 'security', 'username', 'from'] as const).some((k) => draft[k] !== base[k]);

  const save = async () => {
    const local: Record<string, string> = {};
    if (draft.port === null || !Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) local.port = 'Enter a port from 1 to 65535.';
    if (draft.enabled && !draft.host.trim()) local.host = 'Enter the mail server’s host name.';
    if (draft.enabled && !draft.from.trim()) local.from = 'Enter the sender address.';
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length) return;
    const body: UpdateMailServerRequest = {
      enabled: draft.enabled, host: draft.host, port: draft.port!, security: draft.security, username: draft.username.trim() || null, from: draft.from,
      ...(draft.password ? { password: draft.password } : removePassword ? { password: null } : {}),
    };
    setSaving(true);
    try {
      await saveMailSettings(body);
      toast.show({ tone: 'success', title: 'Mail server saved' });
      reload();
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) setErrors(Object.fromEntries(err.issues.map((i) => [i.path, `This ${i.message}.`])));
      else setFormError(failure(err) ?? 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await sendTestMail();
      if (result.sent) toast.show({ tone: 'success', title: 'Test message sent', description: `Sent to ${result.to}. Check that it arrived.` });
      else toast.show({ tone: 'warning', title: 'No test message sent', description: result.reason, duration: 10_000 });
    } catch (err) {
      toast.show({ tone: 'error', title: 'Sending failed', description: failure(err), duration: 10_000 });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      title="Mail server"
      subtitle="Outgoing mail (SMTP) for sign-in codes. The password is stored encrypted and never shown again."
      headingLevel={2}
      headerActions={data.configured ? <StatusIndicator tone="success" size="sm" icon="accept">Ready</StatusIndicator> : <StatusIndicator tone="neutral" size="sm">Not set up</StatusIndicator>}
    >
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)', maxWidth: '40rem' }}>
        {formError && <MessageStrip tone="error" announce="assertive">{formError}</MessageStrip>}
        <Switch label="Send mail" checked={draft.enabled} disabled={!canWrite} onChange={(on) => set("enabled", on)} />
        {errors.enabled && <MessageStrip tone="error">Sending mail {errors.enabled.replace(/^This /, "")}</MessageStrip>}
        <div className="claw-settings-grid">
          <Input label="Host" value={draft.host} readOnly={!canWrite} spellCheck={false} autoCapitalize="none" placeholder="smtp.example.com" onChange={(e) => set('host', e.target.value)} error={errors.host} />
          <Select
            label="Encryption"
            value={draft.security}
            disabled={!canWrite}
            onChange={(v) => {
              if (!v) return;
              const next = SECURITY.find((s) => s.value === v)!;
              // Follow the usual port unless the administrator chose another one.
              const usual = SECURITY.some((s) => s.port === draft.port);
              setDraft({ ...draft, security: next.value, port: usual ? next.port : draft.port });
            }}
            options={SECURITY.map(({ value, label }) => ({ value, label }))}
            error={errors.security}
          />
          <NumberInput label="Port" value={draft.port} readOnly={!canWrite} min={1} max={65535} step={1} onChange={(v) => set('port', v)} error={errors.port} />
          <Input label="Sender" value={draft.from} readOnly={!canWrite} spellCheck={false} placeholder="ClawRouter <clawrouter@example.com>" onChange={(e) => set('from', e.target.value)} error={errors.from} />
          <Input label="Username" description="Leave empty if the server needs no sign-in." value={draft.username} readOnly={!canWrite} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => set('username', e.target.value)} error={errors.username} />
          {canWrite && (
            <div style={{ display: 'grid', gap: 'var(--eui-space-1, 0.25rem)', alignContent: 'start' }}>
              <PasswordInput
                label="Password"
                purpose="current"
                autoComplete="new-password"
                description={removePassword ? 'The stored password will be removed when you save.' : data.passwordSet ? 'A password is stored. Type a new one to replace it.' : 'No password stored.'}
                value={draft.password}
                onChange={(e) => { set('password', e.target.value); setRemovePassword(false); }}
                error={errors.password}
              />
              {data.passwordSet && !removePassword && !draft.password && (
                <div><Button size="sm" variant="tertiary" onClick={() => setRemovePassword(true)}>Remove the stored password</Button></div>
              )}
            </div>
          )}
        </div>
        {canWrite && (
          <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap', alignItems: 'center' }}>
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>Save mail server</Button>
            <Button variant="tertiary" disabled={!dirty || saving} onClick={() => { setDraft(base); setRemovePassword(false); setErrors({}); }}>Discard</Button>
            <Button variant="secondary" icon="email" onClick={() => void test()} loading={testing} disabled={!data.configured || dirty}>Send a test message to me</Button>
            {dirty && data.configured && <Text size="sm" tone="secondary">Save first to test the new settings.</Text>}
          </div>
        )}
      </div>
    </Card>
  );
}
