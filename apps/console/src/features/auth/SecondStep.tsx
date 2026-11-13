import { useState, type FormEvent } from 'react';
import { Button, Form, Input, Link, MessageStrip, Text } from '@enterprise-ui/react';
import type { SignInChallenge, TwoFactorMethod } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { sendSignInCode } from '../../services/auth.ts';
import { useAuth } from './AuthContext.tsx';

type Mode = TwoFactorMethod | 'recovery';

const LABEL: Record<Mode, string> = { totp: 'Code from your authenticator app', email: 'Code from the email', recovery: 'Recovery code' };

/**
 * The second sign-in step (two-factor): a code from the authenticator app, an
 * emailed code, or a one-time recovery code. Too many wrong codes, or 10 minutes,
 * and the password is needed again.
 */
export function SecondStep({ challenge, onRestart }: { challenge: SignInChallenge['twoFactor']; onRestart: (message: string) => void }) {
  const { verifySignIn } = useAuth();
  const [mode, setMode] = useState<Mode>(challenge.methods[0] ?? 'recovery');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);

  const fail = (err: unknown) => {
    if (err instanceof ApiClientError && err.details.reason === 'challenge_expired') return onRestart(err.message);
    setError(err instanceof Error ? err.message : 'That did not work. Try again.');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return setError('Enter the code.');
    setBusy(true);
    setError(null);
    try {
      await verifySignIn({ challenge: challenge.challenge, method: mode, code: code.trim() });
    } catch (err) {
      fail(err);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const { sentTo } = await sendSignInCode(challenge.challenge);
      setInfo(`We sent a code to ${sentTo}. It works for 10 minutes.`);
    } catch (err) {
      fail(err);
    } finally {
      setSending(false);
    }
  };

  const switchTo = (m: Mode) => {
    setMode(m);
    setCode('');
    setError(null);
    setInfo(null);
  };

  return (
    <Form onSubmit={submit} noValidate aria-busy={busy}>
      <Text as="p">Your account has two-factor sign-in. {mode === 'totp' ? 'Open your authenticator app and enter the 6-digit code for ClawRouter.' : mode === 'email' ? 'Get a code by email and enter it here.' : 'Enter one of the recovery codes you saved. Each works once.'}</Text>
      {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
      {info && <MessageStrip tone="information">{info}</MessageStrip>}
      {mode === 'email' && (
        <Button variant="secondary" onClick={() => void send()} loading={sending}>{info ? 'Send another code' : `Send a code to ${challenge.emailHint ?? 'my email'}`}</Button>
      )}
      <Input
        label={LABEL[mode]}
        name="one-time-code"
        autoComplete="one-time-code"
        inputMode={mode === 'recovery' ? 'text' : 'numeric'}
        autoCapitalize="none"
        spellCheck={false}
        required
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="claw-mono"
      />
      <Button type="submit" variant="primary" fullWidth loading={busy}>Sign in</Button>
      <div style={{ display: 'grid', gap: 'var(--eui-space-1, 0.25rem)' }}>
        {challenge.methods.filter((m) => m !== mode).map((m) => (
          <Link key={m} href="#" onClick={(e) => { e.preventDefault(); switchTo(m); }}>{m === 'totp' ? 'Use the authenticator app instead' : 'Get a code by email instead'}</Link>
        ))}
        {mode !== 'recovery' && <Link href="#" onClick={(e) => { e.preventDefault(); switchTo('recovery'); }}>Lost your phone? Use a recovery code</Link>}
        <Link href="#" onClick={(e) => { e.preventDefault(); onRestart(''); }}>Start over</Link>
      </div>
    </Form>
  );
}
