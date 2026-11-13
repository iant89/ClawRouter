import { useState, type FormEvent } from 'react';
import { Button, Form, MessageStrip, PasswordInput } from '@enterprise-ui/react';
import { PASSWORD_POLICY } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { changePassword } from '../../services/auth.ts';

type Field = 'currentPassword' | 'newPassword' | 'confirm';

export interface ChangePasswordFormProps {
  /** Label of the current-password field ("Temporary password" when forced). */
  currentLabel?: string;
  submitLabel?: string;
  onChanged: () => void;
  /** Extra buttons next to submit (e.g. Cancel, Sign out). */
  extraActions?: React.ReactNode;
}

/**
 * Changes the signed-in user's password. The server checks the current
 * password and the policy; the checks here are only for quick feedback.
 */
export function ChangePasswordForm({ currentLabel = 'Current password', submitLabel = 'Change password', onChanged, extraActions }: ChangePasswordFormProps) {
  const [values, setValues] = useState<Record<Field, string>>({ currentPassword: '', newPassword: '', confirm: '' });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (field: Field) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [field]: e.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const local: Partial<Record<Field, string>> = {};
    if (!values.currentPassword) local.currentPassword = `Enter your ${currentLabel.toLowerCase()}.`;
    if (values.newPassword.length < PASSWORD_POLICY.minLength) local.newPassword = `Use at least ${PASSWORD_POLICY.minLength} characters.`;
    if (values.confirm !== values.newPassword) local.confirm = 'The passwords do not match.';
    setErrors(local);
    setError(null);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      await changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword });
      setValues({ currentPassword: '', newPassword: '', confirm: '' });
      onChanged();
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) {
        const fromServer: Partial<Record<Field, string>> = {};
        for (const issue of err.issues) {
          if (issue.path === 'currentPassword') fromServer.currentPassword = `The ${currentLabel.toLowerCase()} ${issue.message}.`;
          if (issue.path === 'newPassword') fromServer.newPassword = `The new password ${issue.message}.`;
        }
        setErrors(fromServer);
      } else if (err instanceof ApiClientError && err.code === 'RATE_LIMITED') {
        setError('Too many wrong passwords. Try again later.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not change the password.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={submit} noValidate aria-busy={busy}>
      {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
      <PasswordInput id="cp-current" label={currentLabel} purpose="current" autoComplete="current-password" required autoFocus value={values.currentPassword} onChange={set('currentPassword')} error={errors.currentPassword} />
      <PasswordInput
        id="cp-new" label="New password" purpose="new" autoComplete="new-password" required value={values.newPassword} onChange={set('newPassword')} error={errors.newPassword}
        requirements={[{ label: `At least ${PASSWORD_POLICY.minLength} characters`, test: (p) => p.length >= PASSWORD_POLICY.minLength }]}
      />
      <PasswordInput id="cp-confirm" label="Confirm new password" purpose="new" autoComplete="new-password" required value={values.confirm} onChange={set('confirm')} error={errors.confirm} />
      <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap' }}>
        <Button type="submit" variant="primary" loading={busy}>{submitLabel}</Button>
        {extraActions}
      </div>
    </Form>
  );
}
