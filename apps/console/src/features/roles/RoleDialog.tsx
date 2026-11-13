import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, Input, MessageStrip, Text } from '@enterprise-ui/react';
import { PERMISSION_DESCRIPTIONS, PERMISSION_GROUPS, PERMISSIONS, type Permission, type RoleInfo } from '@clawrouter/shared';
import { createRole, updateRole } from '../../services/access.ts';
import { ApiClientError } from '../../services/api-client.ts';

export interface RoleDialogProps {
  open: boolean;
  /** The custom role being edited, or null to create one. */
  role: RoleInfo | null;
  /** The signed-in user's permissions: they can only grant what they hold. */
  own: ReadonlySet<string>;
  /** Pre-filled permissions when creating (e.g. "copy of Operator"). */
  template?: Permission[];
  onClose: () => void;
  onSaved: (role: RoleInfo, created: boolean) => void;
}

/**
 * Creates or edits a custom role. Mirrors the server's rules for feedback only:
 * at least one permission, never all of them (that is the Administrator role),
 * and only permissions the signed-in user holds.
 */
export function RoleDialog({ open, role, own, template, onClose, onSaved }: RoleDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<Permission>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? '');
    setDescription(role?.description ?? '');
    setSelected(new Set(role?.permissions ?? template ?? []));
    setError(null);
    setNameError(undefined);
  }, [open, role, template]);

  const toggle = (p: Permission, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });

  const all = selected.size === PERMISSIONS.length;
  const none = selected.size === 0;

  const save = async () => {
    if (!name.trim()) {
      setNameError('Enter a name.');
      return;
    }
    setSaving(true);
    setError(null);
    setNameError(undefined);
    const body = { name: name.trim(), description: description.trim(), permissions: [...selected].sort() };
    try {
      onSaved(role ? await updateRole(role.id, body) : await createRole(body), role === null);
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.some((i) => i.path === 'name')) setNameError(`Name ${err.issues.find((i) => i.path === 'name')!.message}.`);
      else setError(err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => `${i.path} ${i.message}`).join('; ') : err instanceof Error ? err.message : 'Could not save the role.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={role ? `Edit role: ${role.name}` : 'Create role'}
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={all || none}>{role ? 'Save' : 'Create role'}</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        {role && role.memberCount > 0 && (
          <MessageStrip tone="information">{role.memberCount} user{role.memberCount === 1 ? '' : 's'} hold{role.memberCount === 1 ? 's' : ''} this role. Changes apply to them immediately.</MessageStrip>
        )}
        <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} error={nameError} maxLength={64} />
        <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} description="Optional. Shown next to the role when assigning it." />
        <div className="claw-permission-groups">
          {PERMISSION_GROUPS.map((group) => (
            <fieldset key={group.area} style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--eui-space-2, 0.5rem)', alignContent: 'start' }}>
              <legend><Text as="strong">{group.area}</Text></legend>
              {group.permissions.map((p) => {
                const held = own.has(p);
                return (
                  <Checkbox
                    key={p}
                    label={<span className="claw-mono">{p}</span>}
                    description={held ? PERMISSION_DESCRIPTIONS[p] : `${PERMISSION_DESCRIPTIONS[p]}. You do not hold this permission, so you cannot grant it.`}
                    checked={selected.has(p)}
                    disabled={!held && !selected.has(p)}
                    onChange={(checked) => toggle(p, checked)}
                  />
                );
              })}
            </fieldset>
          ))}
        </div>
        <Text size="sm" tone={all || none ? 'warning' : 'secondary'} role="status">
          {all
            ? 'A custom role cannot have every permission: that is the Administrator role. Remove at least one.'
            : none
              ? 'Choose at least one permission.'
              : `${selected.size} of ${PERMISSIONS.length} permissions selected.`}
        </Text>
      </div>
    </Dialog>
  );
}
