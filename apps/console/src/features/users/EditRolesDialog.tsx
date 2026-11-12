import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, MessageStrip, Text } from '@enterprise-ui/react';
import type { RoleInfo, UserWithRoles } from '@clawapi/shared';
import { setUserRoles } from '../../services/access.ts';

export interface EditRolesDialogProps {
  user: UserWithRoles | null;
  roles: RoleInfo[];
  isSelf: boolean;
  onClose: () => void;
  onSaved: (user: UserWithRoles) => void;
}

/** Assigns roles to one user. The server refuses changes that would leave no active administrator. */
export function EditRolesDialog({ user, roles, isSelf, onClose, onSaved }: EditRolesDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelected(new Set(user?.roles ?? []));
    setError(null);
  }, [user]);

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = async () => {
    if (!user) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await setUserRoles(user.id, [...selected]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change roles.');
    } finally {
      setSaving(false);
    }
  };

  const unchanged = user !== null && [...selected].sort().join() === [...user.roles].sort().join();
  return (
    <Dialog
      open={user !== null}
      onClose={onClose}
      title={user ? `Roles for ${user.displayName}` : 'Roles'}
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={unchanged}>Save</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        {isSelf && <MessageStrip tone="warning">You are changing your own roles. Removing access takes effect immediately.</MessageStrip>}
        <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
          <legend><Text as="strong">Roles</Text></legend>
          {roles.map((role) => (
            <Checkbox
              key={role.id}
              label={role.name}
              description={role.description}
              checked={selected.has(role.id)}
              onChange={(checked) => toggle(role.id, checked)}
            />
          ))}
        </fieldset>
        {selected.size === 0 && <Text size="sm" tone="secondary">With no role, the user can sign in but can only see the dashboard and their own sessions.</Text>}
      </div>
    </Dialog>
  );
}
