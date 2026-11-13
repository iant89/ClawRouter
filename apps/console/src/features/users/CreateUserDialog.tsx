import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, Input, MessageStrip, Text } from '@enterprise-ui/react';
import { PASSWORD_POLICY, USERNAME_PATTERN, type RoleInfo, type UserWithRoles } from '@clawrouter/shared';
import { createUser } from '../../services/access.ts';
import { ApiClientError } from '../../services/api-client.ts';
import { TemporaryPasswordField } from './TemporaryPasswordField.tsx';

type Field = 'username' | 'displayName' | 'email' | 'password';

export interface CreateUserDialogProps {
  open: boolean;
  roles: RoleInfo[];
  /** The signed-in user's permissions: roles beyond them cannot be given. */
  own: ReadonlySet<string>;
  /** Whether the signed-in user may assign roles at all. */
  canAssign: boolean;
  onClose: () => void;
  onCreated: (user: UserWithRoles) => void;
}

/** Creates a console user with a temporary password and, optionally, roles. */
export function CreateUserDialog({ open, roles, own, canAssign, onClose, onCreated }: CreateUserDialogProps) {
  const [values, setValues] = useState<Record<Field, string>>({ username: '', displayName: '', email: '', password: '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({ username: '', displayName: '', email: '', password: '' });
    setSelected(new Set(roles.some((r) => r.id === 'VIEWER') ? ['VIEWER'] : []));
    setErrors({});
    setError(null);
  }, [open, roles]);

  const set = (field: Field) => (value: string) => setValues((v) => ({ ...v, [field]: value }));

  const save = async () => {
    const local: Partial<Record<Field, string>> = {};
    if (!USERNAME_PATTERN.test(values.username.trim())) local.username = 'Use 2–64 letters, digits, dots, dashes or underscores, starting with a letter or digit.';
    if (!values.displayName.trim()) local.displayName = 'Enter a display name.';
    if (values.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) local.email = 'Enter an email address, or leave it empty.';
    if (values.password.length < PASSWORD_POLICY.minLength) local.password = `Use at least ${PASSWORD_POLICY.minLength} characters.`;
    setErrors(local);
    setError(null);
    if (Object.keys(local).length) return;
    setSaving(true);
    try {
      onCreated(await createUser({ username: values.username.trim(), displayName: values.displayName.trim(), email: values.email.trim() || null, password: values.password, roles: canAssign ? [...selected] : [] }));
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.some((i) => i.path === 'username' || i.path === 'displayName' || i.path === 'email' || i.path === 'password')) {
        const fromServer: Partial<Record<Field, string>> = {};
        for (const i of err.issues) if (i.path === 'username' || i.path === 'displayName' || i.path === 'email' || i.path === 'password') fromServer[i.path] = `This ${i.message}.`;
        setErrors(fromServer);
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the user.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create user"
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} loading={saving}>Create user</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        <Input label="Username" required autoCapitalize="none" spellCheck={false} value={values.username} onChange={(e) => set('username')(e.target.value)} error={errors.username} description="Used to sign in. Cannot be changed later." />
        <Input label="Display name" required value={values.displayName} onChange={(e) => set('displayName')(e.target.value)} error={errors.displayName} />
        <Input label="Email address" type="email" autoComplete="off" spellCheck={false} autoCapitalize="none" value={values.email} onChange={(e) => set('email')(e.target.value)} error={errors.email} description="Optional. Needed for sign-in codes by email." />
        <TemporaryPasswordField value={values.password} onChange={set('password')} error={errors.password} />
        {canAssign ? (
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
            <legend><Text as="strong">Roles</Text></legend>
            {roles.map((role) => {
              const allowed = role.permissions.every((p) => own.has(p));
              return (
                <Checkbox
                  key={role.id}
                  label={role.name}
                  description={allowed ? role.description : `${role.description} You cannot give this role: it has permissions you do not hold.`}
                  checked={selected.has(role.id)}
                  disabled={!allowed}
                  onChange={(on) => setSelected((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(role.id);
                    else next.delete(role.id);
                    return next;
                  })}
                />
              );
            })}
          </fieldset>
        ) : (
          <Text size="sm" tone="secondary">The user starts with no role. Someone with permission to assign roles can give them one.</Text>
        )}
      </div>
    </Dialog>
  );
}
