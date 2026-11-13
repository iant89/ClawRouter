import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CopyButton, Input, Link, MessageStrip, PasswordInput, StatusIndicator, Text } from '@enterprise-ui/react';
import type { TotpSetup, TwoFactorMethod, TwoFactorStatus } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import {
  changeMyEmail, confirmEmailCodes, confirmTotp, disableMethod, fetchTwoFactor, newRecoveryCodes, startEmailCodes, startTotp,
} from '../../services/two-factor.ts';
import { useAuth } from './AuthContext.tsx';

const message = (err: unknown, fallback: string) =>
  err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => `${i.path === 'code' ? 'The code' : i.path === 'password' ? 'The password' : i.path === 'email' ? 'The email address' : i.path} ${i.message}.`).join(' ') : err instanceof Error ? err.message : fallback;

/** "ABCD EFGH ..." for typing the secret into an app by hand. */
const grouped = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

/**
 * The signed-in user's sign-in security: email address, authenticator app,
 * email codes and recovery codes. Administrators decide which methods are
 * allowed and whether they are required (Settings).
 */
export function AccountSecurity({ onChanged }: { onChanged?: () => void }) {
  const { refresh } = useAuth();
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus(await fetchTwoFactor());
    } catch (err) {
      setError(message(err, 'Could not load your sign-in security.'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const changed = async (newCodes?: string[]) => {
    await load();
    // New recovery codes: refresh the session only once they are saved, because
    // the refresh can end the forced-setup screen and hide them.
    if (newCodes?.length) return setCodes(newCodes);
    await refresh();
    onChanged?.();
  };
  const codesSaved = async () => {
    setCodes(null);
    await refresh();
    onChanged?.();
  };

  if (!status) return error ? <MessageStrip tone="error">{error}</MessageStrip> : <Text tone="secondary">Loading…</Text>;
  const on = (m: TwoFactorMethod) => status.enrolled.includes(m);

  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
      {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
      {status.required && !status.enrolled.length && (
        <MessageStrip tone="warning" title="Two-factor sign-in is required">Your administrator requires it for your account. Set up one of the methods below to continue.</MessageStrip>
      )}
      {codes && <RecoveryCodesCard codes={codes} onDone={() => void codesSaved()} />}
      <EmailCard status={status} onChanged={() => void changed()} />
      {status.allowed.includes('totp') || on('totp') ? <TotpCard enabled={on('totp')} onChanged={(c) => void changed(c)} /> : null}
      {status.allowed.includes('email') || on('email') ? <EmailCodesCard status={status} enabled={on('email')} onChanged={(c) => void changed(c)} /> : null}
      {!status.allowed.length && !status.enrolled.length && <Text tone="secondary">Two-factor sign-in is not enabled on this server. An administrator can enable it in Settings.</Text>}
      {status.enrolled.length > 0 && <RecoveryCard left={status.recoveryCodesLeft} onCodes={(c) => void changed(c)} />}
    </div>
  );
}

function RecoveryCodesCard({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n');
  return (
    <Card title="Save your recovery codes" subtitle="Shown only now. Each code signs you in once if you lose your phone or email." headingLevel={3}>
      <div style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
        <pre className="claw-mono claw-code" aria-label="Recovery codes">{codes.map((c, i) => `${String(i + 1).padStart(2, ' ')}. ${c}`).join('\n')}</pre>
        <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap' }}>
          <CopyButton value={text} label="Copy codes" />
          <Button variant="secondary" onClick={() => {
            const url = URL.createObjectURL(new Blob([`ClawRouter recovery codes\n\n${text}\n`], { type: 'text/plain' }));
            const a = Object.assign(document.createElement('a'), { href: url, download: 'clawrouter-recovery-codes.txt' });
            a.click();
            URL.revokeObjectURL(url);
          }}>Download</Button>
          <Button variant="primary" onClick={onDone}>I have saved them</Button>
        </div>
      </div>
    </Card>
  );
}

function EmailCard({ status, onChanged }: { status: TwoFactorStatus; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(status.email ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await changeMyEmail(email.trim() || null, password);
      setEditing(false);
      setPassword('');
      onChanged();
    } catch (err) {
      setError(message(err, 'Could not save the email address.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Email address" subtitle="For sign-in codes and mail from ClawRouter." headingLevel={3}>
      {!editing ? (
        <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'center', flexWrap: 'wrap' }}>
          {status.email ? <span className="claw-mono">{status.email}</span> : <Text tone="secondary">Not set</Text>}
          <Button size="sm" variant="tertiary" onClick={() => { setEditing(true); setEmail(status.email ?? ''); }}>{status.email ? 'Change' : 'Add'}</Button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
          {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
          <Input label="Email address" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} description={status.enrolled.includes('email') ? 'A new address turns email codes off until you confirm it.' : 'Leave empty to remove it.'} />
          <PasswordInput label="Your password" purpose="current" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)' }}>
            <Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
            <Button variant="tertiary" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function TotpCard({ enabled, onChanged }: { enabled: boolean; onChanged: (codes?: string[]) => void }) {
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [removing, setRemoving] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(message(err, fallback)); } finally { setBusy(false); }
  };

  return (
    <Card
      title="Authenticator app"
      subtitle="A 6-digit code from an app such as Google Authenticator, Microsoft Authenticator, 1Password or Authy."
      headingLevel={3}
      headerActions={<StatusIndicator tone={enabled ? 'success' : 'neutral'} size="sm">{enabled ? 'On' : 'Off'}</StatusIndicator>}
    >
      <div style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        {!enabled && !setup && <div><Button variant="primary" loading={busy} onClick={() => void run(async () => setSetup(await startTotp()), 'Could not start.')}>Set up</Button></div>}
        {setup && (
          <>
            <Text as="p">1. In your authenticator app, add an account and enter this key (or, on your phone, <Link href={setup.uri}>open it in the app</Link>):</Text>
            <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'center', flexWrap: 'wrap' }}>
              <code className="claw-mono claw-secret" aria-label="Setup key">{grouped(setup.secret)}</code>
              <CopyButton value={setup.secret} label="Copy key" />
            </div>
            <Text size="sm" tone="secondary">Time-based, 6 digits, every 30 seconds. The key is shown only now.</Text>
            <Text as="p">2. Enter the code the app shows:</Text>
            <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'end', flexWrap: 'wrap' }}>
              <Input label="Code from the app" inputMode="numeric" autoComplete="one-time-code" className="claw-mono" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: '10rem' }} />
              <Button variant="primary" loading={busy} onClick={() => void run(async () => {
                const result = await confirmTotp(code.trim());
                setSetup(null);
                setCode('');
                onChanged(result.codes);
              }, 'Could not confirm the code.')}>Turn on</Button>
              <Button variant="tertiary" onClick={() => setSetup(null)}>Cancel</Button>
            </div>
          </>
        )}
        {enabled && !removing && <div><Button variant="tertiary" onClick={() => setRemoving(true)}>Remove</Button></div>}
        {enabled && removing && (
          <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'end', flexWrap: 'wrap' }}>
            <PasswordInput label="Your password" purpose="current" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button variant="primary" loading={busy} onClick={() => void run(async () => {
              await disableMethod('totp', password);
              setRemoving(false);
              setPassword('');
              onChanged();
            }, 'Could not remove it.')}>Remove app</Button>
            <Button variant="tertiary" onClick={() => setRemoving(false)}>Cancel</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function EmailCodesCard({ status, enabled, onChanged }: { status: TwoFactorStatus; enabled: boolean; onChanged: (codes?: string[]) => void }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(message(err, fallback)); } finally { setBusy(false); }
  };
  const blocked = !status.mailConfigured ? 'No mail server is configured yet.' : !status.email ? 'Add an email address first.' : null;

  return (
    <Card title="Email codes" subtitle="A 6-digit code sent to your email address when you sign in." headingLevel={3}
      headerActions={<StatusIndicator tone={enabled ? 'success' : 'neutral'} size="sm">{enabled ? 'On' : 'Off'}</StatusIndicator>}>
      <div style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        {!enabled && blocked && <Text tone="secondary">{blocked}</Text>}
        {!enabled && !blocked && !sentTo && <div><Button variant="primary" loading={busy} onClick={() => void run(async () => setSentTo((await startEmailCodes()).sentTo), 'Could not send a code.')}>Turn on</Button></div>}
        {!enabled && sentTo && (
          <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'end', flexWrap: 'wrap' }}>
            <Input label={`Code sent to ${sentTo}`} inputMode="numeric" autoComplete="one-time-code" className="claw-mono" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: '12rem' }} />
            <Button variant="primary" loading={busy} onClick={() => void run(async () => {
              const result = await confirmEmailCodes(code.trim());
              setSentTo(null);
              setCode('');
              onChanged(result.codes);
            }, 'Could not confirm the code.')}>Confirm</Button>
            <Button variant="tertiary" onClick={() => setSentTo(null)}>Cancel</Button>
          </div>
        )}
        {enabled && !removing && <div><Button variant="tertiary" onClick={() => setRemoving(true)}>Turn off</Button></div>}
        {enabled && removing && (
          <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'end', flexWrap: 'wrap' }}>
            <PasswordInput label="Your password" purpose="current" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button variant="primary" loading={busy} onClick={() => void run(async () => {
              await disableMethod('email', password);
              setRemoving(false);
              setPassword('');
              onChanged();
            }, 'Could not turn it off.')}>Turn off</Button>
            <Button variant="tertiary" onClick={() => setRemoving(false)}>Cancel</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function RecoveryCard({ left, onCodes }: { left: number; onCodes: (codes: string[]) => void }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Recovery codes" subtitle={`${left} unused. Each signs you in once without your phone or email.`} headingLevel={3}>
      <div style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        {left <= 3 && <MessageStrip tone="warning">You are running out of recovery codes. Make new ones.</MessageStrip>}
        {!asking ? <div><Button variant="tertiary" onClick={() => setAsking(true)}>Make new codes</Button></div> : (
          <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'end', flexWrap: 'wrap' }}>
            <PasswordInput label="Your password" purpose="current" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} description="The old codes stop working." />
            <Button variant="primary" loading={busy} onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const { codes } = await newRecoveryCodes(password);
                setAsking(false);
                setPassword('');
                onCodes(codes);
              } catch (err) {
                setError(message(err, 'Could not make new codes.'));
              } finally {
                setBusy(false);
              }
            }}>Make new codes</Button>
            <Button variant="tertiary" onClick={() => setAsking(false)}>Cancel</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
