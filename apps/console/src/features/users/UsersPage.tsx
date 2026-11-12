import { useMemo, useState } from 'react';
import { Button, MessageStrip, Page, RefreshControl, StatusIndicator, Table, Text, useToast, type TableColumn } from '@enterprise-ui/react';
import type { RoleInfo, UserWithRoles } from '@clawapi/shared';
import { RoleTags } from '../../components/custom/RoleTags.tsx';
import { useResource } from '../../hooks/useResource.ts';
import { fetchRoles, fetchUsers } from '../../services/access.ts';
import { formatRelative } from '../../services/format.ts';
import { useAuth, usePermissions, useSession } from '../auth/AuthContext.tsx';
import { EditRolesDialog } from './EditRolesDialog.tsx';

const loadAll = async (signal: AbortSignal): Promise<{ users: UserWithRoles[]; roles: RoleInfo[] }> => {
  const [users, roles] = await Promise.all([fetchUsers(signal), fetchRoles(signal)]);
  return { users, roles };
};

/**
 * Administration → Users: who can sign in and which roles they hold. Creating,
 * disabling and resetting users is phase 14.
 */
export function UsersPage() {
  const toast = useToast();
  const { can } = usePermissions();
  const { refresh } = useAuth();
  const { user: me } = useSession();
  const { data, error, loading, lastUpdated, reload } = useResource(loadAll);
  const [editing, setEditing] = useState<UserWithRoles | null>(null);
  const names = useMemo(() => new Map((data?.roles ?? []).map((r) => [r.id, r.name])), [data]);
  const canAssign = can('roles.assign');

  const columns: TableColumn<UserWithRoles>[] = [
    {
      id: 'user', header: 'User', rowHeader: true, accessor: 'displayName', sortable: true,
      cell: (u) => <span>{u.displayName} <Text size="sm" tone="secondary">({u.username})</Text>{u.id === me.id && <> <StatusIndicator tone="information" size="sm">You</StatusIndicator></>}</span>,
    },
    { id: 'roles', header: 'Roles', accessor: (u) => u.roles.join(', '), cell: (u) => <RoleTags roles={u.roles} names={names} /> },
    {
      id: 'status', header: 'Status', accessor: 'status',
      cell: (u) => <StatusIndicator tone={u.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm">{u.status === 'ACTIVE' ? 'Active' : 'Disabled'}</StatusIndicator>,
    },
    { id: 'login', header: 'Last sign-in', accessor: (u) => u.lastLoginAt ?? '', cell: (u) => (u.lastLoginAt ? <span title={new Date(u.lastLoginAt).toLocaleString()}>{formatRelative(u.lastLoginAt)}</span> : <Text tone="secondary">Never</Text>), sortable: true },
    ...(canAssign
      ? [{ id: 'actions', header: 'Actions', align: 'end' as const, cell: (u: UserWithRoles) => <Button size="sm" variant="tertiary" onClick={() => setEditing(u)}>Edit roles</Button> }]
      : []),
  ];

  return (
    <Page
      title="Users"
      subtitle="Console users and their roles"
      actions={<RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />}
    >
      {error && <MessageStrip tone="error" title="Cannot load users">{error}</MessageStrip>}
      <Table caption="Users" columns={columns} data={data?.users ?? []} getRowId={(u) => u.id} getRowLabel={(u) => u.displayName} loading={loading && !data} emptyState="No users." />
      <Text as="p" size="sm" tone="secondary">Adding, disabling and resetting users arrives with user management (phase 14).</Text>
      <EditRolesDialog
        user={editing}
        roles={data?.roles ?? []}
        isSelf={editing?.id === me.id}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          setEditing(null);
          toast.show({ tone: 'success', title: 'Roles updated', description: `${updated.displayName}: ${updated.roles.map((r) => names.get(r) ?? r).join(', ') || 'no role'}` });
          reload();
          if (updated.id === me.id) void refresh();
        }}
      />
    </Page>
  );
}
