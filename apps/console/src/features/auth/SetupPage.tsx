import { useMemo, useState, type FormEvent } from 'react';
import { Button, Form, FormErrorSummary, Input, MessageStrip, PasswordInput, Text, type FormErrorSummaryItem } from '@enterprise-ui/react';
import { PASSWORD_POLICY, USERNAME_PATTERN } from '@clawapi/shared';
import { AuthPanel } from '../../components/custom/AuthPanel.tsx';
import { ApiClientError } from '../../services/api-client.ts';
import { useAuth } from './AuthContext.tsx';

type Field = 'setupToken' | 'username' | 'displayName' | 'password' | 'confirm';
const LABELS: Record<Field, string> = {
  setupToken: 'Setup token',
  username: 'Username',
  displayName: 'Display name',
  password: 'Password',
  confirm: 'Confirm password',
};

/** Client-side checks give quick feedback; the server enforces the real rules. */
function validate(values: Record<Field, string>): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!values.setupToken.trim()) errors.setupToken = 'Enter the setup token from the server.';
  if (!USERNAME_PATTERN.test(values.username.trim())) errors.username = 'Use 2–64 letters, digits, dots, dashes or underscores.';
  if (!values.displayName.trim()) errors.displayName = 'Enter a display name.';
  if (values.password.length < PASSWORD_POLICY.minLength) errors.password = `Use at least ${PASSWORD_POLICY.minLength} characters.`;
  if (values.confirm !== values.password) errors.confirm = 'Passwords do not match.';
  return errors;
}

export function SetupPage() {
  const { completeSetup } = useAuth();
  const [values, setValues] = useState<Record<Field, string>>({ setupToken: '', username: 'admin', displayName: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  const set = (field: Field) => (event: { target: { value: string } }) => setValues((v) => ({ ...v, [field]: event.target.value }));
  const summary = useMemo<FormErrorSummaryItem[]>(
    () => (Object.entries(errors) as [Field, string][]).map(([field, message]) => ({ id: `setup-${field}`, label: LABELS[field], message })),
    [errors],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    setFormError(null);
    setAttempt((n) => n + 1);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await completeSetup({ setupToken: values.setupToken.trim(), username: values.username.trim(), displayName: values.displayName.trim(), password: values.password });
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) {
        const fromServer: Partial<Record<Field, string>> = {};
        for (const issue of err.issues) if (issue.path in LABELS) fromServer[issue.path as Field] = `${LABELS[issue.path as Field]} ${issue.message}.`;
        setErrors(fromServer);
      } else {
        setFormError(err instanceof Error ? err.message : 'Setup failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthPanel title="Initial setup" subtitle="Create the first administrator">
      <Form onSubmit={submit} noValidate aria-busy={busy}>
        <Text as="p" size="sm" tone="secondary">
          The setup token is in the <code className="claw-mono">setup-token</code> file next to the database (the server log shows the
          path), or in <code className="claw-mono">CLAWAPI_SETUP_TOKEN</code> if the operator set one. Setup can only be done once.
        </Text>
        {summary.length > 0 && <FormErrorSummary errors={summary} focusKey={attempt} />}
        {formError && <MessageStrip tone="error" announce="assertive">{formError}</MessageStrip>}
        <PasswordInput id="setup-setupToken" label={LABELS.setupToken} purpose="current" autoComplete="off" required value={values.setupToken} onChange={set('setupToken')} error={errors.setupToken} />
        <Input id="setup-username" label={LABELS.username} autoComplete="username" autoCapitalize="none" spellCheck={false} required value={values.username} onChange={set('username')} error={errors.username} />
        <Input id="setup-displayName" label={LABELS.displayName} autoComplete="name" required value={values.displayName} onChange={set('displayName')} error={errors.displayName} />
        <PasswordInput
          id="setup-password"
          label={LABELS.password}
          purpose="new"
          autoComplete="new-password"
          required
          value={values.password}
          onChange={set('password')}
          error={errors.password}
          requirements={[{ label: `At least ${PASSWORD_POLICY.minLength} characters`, test: (p) => p.length >= PASSWORD_POLICY.minLength }]}
        />
        <PasswordInput id="setup-confirm" label={LABELS.confirm} purpose="new" autoComplete="new-password" required value={values.confirm} onChange={set('confirm')} error={errors.confirm} />
        <Button type="submit" variant="primary" fullWidth loading={busy}>Create administrator</Button>
      </Form>
    </AuthPanel>
  );
}
