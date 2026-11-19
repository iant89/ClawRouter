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

import { useState, type FormEvent } from 'react';
import { Button, Form, Input, MessageStrip, PasswordInput } from '@enterprise-ui/react';
import { AuthPanel } from '../../components/custom/AuthPanel.tsx';
import { ApiClientError } from '../../services/api-client.ts';
import { useAuth } from './AuthContext.tsx';
import { SecondStep } from './SecondStep.tsx';
import type { SignInChallenge } from '@clawrouter/shared';

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
  const [challenge, setChallenge] = useState<SignInChallenge['twoFactor'] | null>(null);
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
      const second = await signIn({ username: username.trim(), password });
      if (second) {
        setChallenge(second);
        setPassword('');
      }
    } catch (err) {
      setError(describe(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  if (challenge) {
    return (
      <AuthPanel title="Two-factor sign-in" subtitle={username}>
        <SecondStep challenge={challenge} onRestart={(message) => { setChallenge(null); setError(message || null); }} />
      </AuthPanel>
    );
  }

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
