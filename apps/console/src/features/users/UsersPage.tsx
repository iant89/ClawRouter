import { useEffect, useMemo, useState } from 'react';
import {
  AlertDialog, Button, Dialog, Input, MessageStrip, OverflowMenu, Page, RefreshControl, StatusIndicator, Table, Text, useToast, type TableColumn,
} from '@enterprise-ui/react';
import type { RoleInfo, UserWithRoles } from '@clawrouter/shared';
import { RoleTags } from '../../components/custom/RoleTags.tsx';
import { useResource } from '../../hooks/useResource.ts';
import { fetchRoles, fetchUsers, updateUser } from '../../services/access.ts';
import { ApiClientError } from '../../services/api-client.ts';
import { formatRelative } from '../../services/format.ts';
import { resetUserTwoFactor } from '../../services/two-factor.ts';
import { useAuth, usePermissions, useSession } from '../auth/AuthContext.tsx';
import { useRealtimeEvent } from '../realtime/RealtimeContext.tsx';
import { CreateUserDialog } from './CreateUserDialog.tsx';
import { EditRolesDialog } from './EditRolesDialog.tsx';
import { ResetPasswordDialog } from './ResetPasswordDialog.tsx';

const loadAll = async (signal: AbortSignal): Promise<{ users: UserWithRoles[]; roles: RoleInfo[] }> => {
  const [users, roles] = await Promise.all([fetchUsers(signal), fetchRoles(signal)]);
  return { users, roles };
};

/**
 * Administration → Users: who can sign in, which roles they hold, and their
 * lifecycle (create, rename, disable, reset password). The server refuses
 * anything that would disable yourself, remove the last administrator, or touch
 * a user more powerful than you.
 */
export function UsersPage() {
  const toast = useToast();
  const { can, set: own } = usePermissions();
  const { refresh } = useAuth();
  const { user: me } = useSession();
  const { data, error, loading, lastUpdated, reload } = useResource(loadAll);
  const [editingRoles, setEditingRoles] = useState<UserWithRoles | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserWithRoles | null>(null);
  const [renaming, setRenaming] = useState<UserWithRoles | null>(null);
  const [disabling, setDisabling] = useState<UserWithRoles | null>(null);
  const [resetting2fa, setResetting2fa] = useState<UserWithRoles | null>(null);
  useRealtimeEvent(['user.changed', 'role.changed'], () => reload(), 300);
  const names = useMemo(() => new Map((data?.roles ?? []).map((r) => [r.id, r.name])), [data]);
  const permissionsOf = useMemo(() => new Map((data?.roles ?? []).map((r) => [r.id, r.permissions])), [data]);
  const canAssign = can('roles.assign');
  const canWrite = can('users.write');
  // Only users whose permissions you hold yourself can be managed (the server enforces this).
  const manageable = (u: UserWithRoles) => u.roles.every((r) => (permissionsOf.get(r) ?? []).every((p) => own.has(p)));

  const fail = (title: string, err: unknown) => toast.show({ tone: 'error', title, description: err instanceof Error ? err.message : undefined, duration: 10_000 });

  const setStatus = async (u: UserWithRoles, status: 'ACTIVE' | 'DISABLED') => {
    try {
      await updateUser(u.id, { status });
      toast.show({ tone: 'success', title: status === 'ACTIVE' ? 'User enabled' : 'User disabled', description: status === 'ACTIVE' ? `${u.displayName} can sign in again.` : `${u.displayName} was signed out and cannot sign in.` });
      reload();
    } catch (err) {
      fail(status === 'ACTIVE' ? 'Cannot enable the user' : 'Cannot disable the user', err);
    }
  };

  const actionsFor = (u: UserWithRoles) => {
    const self = u.id === me.id;
    const ok = manageable(u);
    const items: ({ id: string; label: string; destructive?: boolean; disabled?: boolean } | { type: 'separator' })[] = [];
    if (canAssign) items.push({ id: 'roles', label: 'Edit roles' });
    if (canWrite) {
      items.push({ id: 'rename', label: 'Edit details', disabled: !self && !ok });
      if (!self) {
        items.push({ id: 'reset', label: 'Reset password', disabled: !ok });
        if (u.twoFactor.length) items.push({ id: 'reset2fa', label: 'Reset two-factor sign-in', disabled: !ok });
        items.push({ type: 'separator' });
        items.push(u.status === 'ACTIVE' ? { id: 'disable', label: 'Disable user', destructive: true, disabled: !ok } : { id: 'enable', label: 'Enable user', disabled: !ok });
      }
    }
    return items;
  };

  const columns: TableColumn<UserWithRoles>[] = [
    {
      id: 'user', header: 'User', rowHeader: true, accessor: 'displayName', sortable: true,
      cell: (u) => <span>{u.displayName} <Text size="sm" tone="secondary">({u.username})</Text>{u.id === me.id && <> <StatusIndicator tone="information" size="sm">You</StatusIndicator></>}</span>,
    },
    { id: 'roles', header: 'Roles', accessor: (u) => u.roles.join(', '), cell: (u) => (u.roles.length ? <RoleTags roles={u.roles} names={names} /> : <Text tone="secondary">No role</Text>) },
    {
      id: 'status', header: 'Status', accessor: 'status',
      cell: (u) => (
        <span style={{ display: 'inline-flex', gap: 'var(--eui-space-1, 0.25rem)', flexWrap: 'wrap' }}>
          <StatusIndicator tone={u.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm">{u.status === 'ACTIVE' ? 'Active' : 'Disabled'}</StatusIndicator>
          {u.mustChangePassword && <StatusIndicator tone="warning" size="sm" icon="key">Temporary password</StatusIndicator>}
          {u.twoFactor.length > 0 && <StatusIndicator tone="success" size="sm" icon="locked">Two-factor: {u.twoFactor.map((m) => (m === 'totp' ? 'app' : 'email')).join(', ')}</StatusIndicator>}
        </span>
      ),
    },
    { id: 'login', header: 'Last sign-in', accessor: (u) => u.lastLoginAt ?? '', cell: (u) => (u.lastLoginAt ? <span title={new Date(u.lastLoginAt).toLocaleString()}>{formatRelative(u.lastLoginAt)}</span> : <Text tone="secondary">Never</Text>), sortable: true },
    ...(canAssign || canWrite
      ? [{
        id: 'actions', header: 'Actions', align: 'end' as const,
        cell: (u: UserWithRoles) => (
          <OverflowMenu
            label={`Actions for ${u.displayName}`}
            items={actionsFor(u)}
            onAction={(id) => {
              if (id === 'roles') setEditingRoles(u);
              if (id === 'rename') setRenaming(u);
              if (id === 'reset') setResetting(u);
              if (id === 'reset2fa') setResetting2fa(u);
              if (id === 'disable') setDisabling(u);
              if (id === 'enable') void setStatus(u, 'ACTIVE');
            }}
          />
        ),
      }]
      : []),
  ];

  return (
    <Page
      title="Users"
      subtitle="Console users, their roles and their access"
      actions={
        <>
          {canWrite && <Button variant="primary" icon="add" onClick={() => setCreating(true)}>Create user</Button>}
          <RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
        </>
      }
    >
      {error && <MessageStrip tone="error" title="Cannot load users">{error}</MessageStrip>}
      <Table caption="Users" columns={columns} data={data?.users ?? []} getRowId={(u) => u.id} getRowLabel={(u) => u.displayName} loading={loading && !data} emptyState="No users." />
      <Text as="p" size="sm" tone="secondary">
        Lost the only administrator password? Run <span className="claw-mono">bun run reset-password &lt;username&gt;</span> on the server.
      </Text>
      <CreateUserDialog
        open={creating}
        roles={data?.roles ?? []}
        own={own}
        canAssign={canAssign}
        onClose={() => setCreating(false)}
        onCreated={(u) => {
          setCreating(false);
          toast.show({ tone: 'success', title: 'User created', description: `${u.displayName} must choose a new password at the first sign-in.` });
          reload();
        }}
      />
      <EditRolesDialog
        user={editingRoles}
        roles={data?.roles ?? []}
        isSelf={editingRoles?.id === me.id}
        onClose={() => setEditingRoles(null)}
        onSaved={(updated) => {
          setEditingRoles(null);
          toast.show({ tone: 'success', title: 'Roles updated', description: `${updated.displayName}: ${updated.roles.map((r) => names.get(r) ?? r).join(', ') || 'no role'}` });
          reload();
          if (updated.id === me.id) void refresh();
        }}
      />
      <ResetPasswordDialog
        user={resetting}
        onClose={() => setResetting(null)}
        onDone={(u) => {
          setResetting(null);
          toast.show({ tone: 'success', title: 'Password reset', description: `${u.displayName} was signed out and must choose a new password.` });
          reload();
        }}
      />
      <EditDetailsDialog
        user={renaming}
        isSelf={renaming?.id === me.id}
        onClose={() => setRenaming(null)}
        onDone={(u) => {
          setRenaming(null);
          reload();
          if (u.id === me.id) void refresh();
        }}
      />
      <AlertDialog
        open={resetting2fa !== null}
        tone="warning"
        title="Reset two-factor sign-in?"
        confirmLabel="Reset"
        onCancel={() => setResetting2fa(null)}
        onConfirm={async () => {
          const u = resetting2fa;
          setResetting2fa(null);
          if (!u) return;
          try {
            await resetUserTwoFactor(u.id);
            toast.show({ tone: 'success', title: 'Two-factor sign-in reset', description: `${u.displayName} signs in with the password only until they set it up again.` });
            reload();
          } catch (err) {
            fail('Cannot reset two-factor sign-in', err);
          }
        }}
      >
        {resetting2fa && `Removes ${resetting2fa.displayName}'s authenticator app, email codes and recovery codes. Use it when they lost their phone. If two-factor sign-in is required, they must set it up again at the next sign-in.`}
      </AlertDialog>
      <AlertDialog
        open={disabling !== null}
        tone="warning"
        title="Disable this user?"
        confirmLabel="Disable"
        onCancel={() => setDisabling(null)}
        onConfirm={async () => {
          if (disabling) await setStatus(disabling, 'DISABLED');
          setDisabling(null);
        }}
      >
        {disabling && `${disabling.displayName} will be signed out everywhere and cannot sign in until enabled again.`}
      </AlertDialog>
    </Page>
  );
}


/**
 * Display name, and for other users the email address (sign-in codes go there,
 * so changing it turns email codes off until the user confirms the new one).
 * Your own address is changed under Sign-in security, with your password.
 */
function EditDetailsDialog({ user, isSelf, onClose, onDone }: { user: UserWithRoles | null; isSelf: boolean; onClose: () => void; onDone: (u: UserWithRoles) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setName(user?.displayName ?? '');
    setEmail(user?.email ?? '');
    setErrors({});
  }, [user]);

  const emailChanged = !isSelf && email.trim() !== (user?.email ?? '');
  const save = async () => {
    if (!user) return;
    const local: { name?: string; email?: string } = {};
    if (!name.trim()) local.name = 'Enter a display name.';
    if (emailChanged && email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) local.email = 'Enter an email address, or leave it empty.';
    setErrors(local);
    if (Object.keys(local).length) return;
    setSaving(true);
    try {
      onDone(await updateUser(user.id, { displayName: name.trim(), ...(emailChanged ? { email: email.trim() || null } : {}) }));
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.some((i) => i.path === 'email')) setErrors({ email: `This ${err.issues.find((i) => i.path === 'email')!.message}.` });
      else setErrors({ name: err instanceof Error ? err.message : 'Could not save.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={user !== null}
      onClose={onClose}
      title="Edit details"
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={name.trim() === user?.displayName && !emailChanged}>Save</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        <Input label="Display name" required value={name} maxLength={128} onChange={(e) => setName(e.target.value)} error={errors.name} description={user ? `Username: ${user.username}` : undefined} />
        {isSelf ? (
          <Text size="sm" tone="secondary">Change your own email address under the user menu → Sign-in security.</Text>
        ) : (
          <Input
            label="Email address"
            type="email"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            description={user?.twoFactor.includes('email') && emailChanged ? 'Email codes are turned off for this user until they confirm the new address.' : 'Optional. Sign-in codes by email go here.'}
          />
        )}
      </div>
    </Dialog>
  );
}
