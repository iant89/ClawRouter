import { useState, type FormEvent } from 'react';
import { Button, Form, Input, MessageStrip, PasswordInput } from '@enterprise-ui/react';
import { AuthPanel } from '../../components/custom/AuthPanel.tsx';
import { ApiClientError } from '../../services/api-client.ts';
import { useAuth } from './AuthContext.tsx';

function describe(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'RATE_LIMITED') {
      const minutes = error.retryAfter ? Math.ceil(error.retryAfter / 60) : null;
      return minutes ? `Too many failed attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.` : error.message;
    }
    return error.message;
  }
  return 'Sign-in failed. Try again.';
}

export function LoginPage() {
  const { state, signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reason = state.status === 'signed-out' ? state.reason : 'none';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn({ username: username.trim(), password });
    } catch (err) {
      setError(describe(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthPanel title="Sign in" subtitle="Administration console">
      <Form onSubmit={submit} noValidate aria-busy={busy}>
        {reason === 'expired' && !error && <MessageStrip tone="information">Your session ended. Sign in again to continue.</MessageStrip>}
        {reason === 'signed-out' && !error && <MessageStrip tone="success">You have signed out.</MessageStrip>}
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        <Input label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        <PasswordInput label="Password" name="password" purpose="current" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" fullWidth loading={busy}>Sign in</Button>
      </Form>
    </AuthPanel>
  );
}
