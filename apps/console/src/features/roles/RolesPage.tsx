import { useState } from 'react';
import {
  AlertDialog, Button, Card, Icon, MessageStrip, OverflowMenu, Page, RefreshControl, StatusIndicator, Table, Text, useToast, VisuallyHidden, type TableColumn,
} from '@enterprise-ui/react';
import { ADMIN_ROLE_ID, PERMISSION_DESCRIPTIONS, PERMISSIONS, type Permission, type RoleInfo } from '@clawrouter/shared';
import { useResource } from '../../hooks/useResource.ts';
import { deleteRole, fetchRoles } from '../../services/access.ts';
import { usePermissions } from '../auth/AuthContext.tsx';
import { useRealtimeEvent } from '../realtime/RealtimeContext.tsx';
import { RoleDialog } from './RoleDialog.tsx';

interface MatrixRow {
  permission: Permission;
  grants: Record<string, boolean>;
}

type Editing = { role: RoleInfo | null; template?: Permission[] } | null;

/**
 * Administration → Roles: what each role may do, and custom roles. The
 * built-in Administrator, Operator and Viewer roles are fixed; Administrator is
 * the only role that may hold every permission (owner rule, enforced by the server).
 */
export function RolesPage() {
  const toast = useToast();
  const { can, set: own } = usePermissions();
  const { data: roles, error, loading, lastUpdated, reload } = useResource(fetchRoles);
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<RoleInfo | null>(null);
  useRealtimeEvent(['role.changed'], () => reload(), 300);
  const canWrite = can('roles.write');
  // A role is editable only when it lies within the user's own permissions (no escalation).
  const within = (r: RoleInfo) => r.permissions.every((p) => own.has(p));

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      await deleteRole(removing.id);
      toast.show({ tone: 'success', title: 'Role deleted', description: removing.name });
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: 'Cannot delete the role', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    } finally {
      setRemoving(null);
    }
  };

  const actionsFor = (r: RoleInfo) => {
    const items: { id: string; label: string; destructive?: boolean; disabled?: boolean }[] = [];
    if (!r.builtIn) items.push({ id: 'edit', label: 'Edit', disabled: !within(r) });
    // Administrator has every permission, which no copy may have.
    if (r.id !== ADMIN_ROLE_ID) items.push({ id: 'copy', label: 'Duplicate as new role', disabled: !within(r) });
    if (!r.builtIn) items.push({ id: 'delete', label: 'Delete', destructive: true, disabled: !within(r) || r.memberCount > 0 });
    return items;
  };

  const roleColumns: TableColumn<RoleInfo>[] = [
    {
      id: 'name', header: 'Role', rowHeader: true, accessor: 'name',
      cell: (r) => (
        <span>
          {r.name}{' '}
          {r.builtIn
            ? <StatusIndicator tone="neutral" size="sm" icon="locked">{r.id === ADMIN_ROLE_ID ? 'Built-in, all permissions' : 'Built-in'}</StatusIndicator>
            : <StatusIndicator tone="information" size="sm">Custom</StatusIndicator>}
        </span>
      ),
    },
    { id: 'description', header: 'Description', accessor: 'description', wrap: true, cell: (r) => r.description || <Text tone="secondary">—</Text> },
    { id: 'permissions', header: 'Permissions', align: 'end', accessor: (r) => r.permissions.length, cell: (r) => <span className="claw-mono">{r.permissions.length}/{PERMISSIONS.length}</span> },
    { id: 'members', header: 'Users', align: 'end', accessor: 'memberCount', cell: (r) => <span className="claw-mono">{r.memberCount}</span> },
    ...(canWrite
      ? [{
        id: 'actions', header: 'Actions', align: 'end' as const,
        cell: (r: RoleInfo) => {
          const items = actionsFor(r);
          return items.length ? (
            <OverflowMenu
              label={`Actions for ${r.name}`}
              items={items}
              onAction={(id) => {
                if (id === 'edit') setEditing({ role: r });
                if (id === 'copy') setEditing({ role: null, template: r.permissions });
                if (id === 'delete') setRemoving(r);
              }}
            />
          ) : null;
        },
      }]
      : []),
  ];

  const matrix: MatrixRow[] = PERMISSIONS.map((permission) => ({
    permission,
    grants: Object.fromEntries((roles ?? []).map((r) => [r.id, r.permissions.includes(permission)])),
  }));

  const matrixColumns: TableColumn<MatrixRow>[] = [
    {
      id: 'permission', header: 'Permission', rowHeader: true, accessor: 'permission', wrap: true,
      cell: (row) => (
        <span>
          <span className="claw-mono">{row.permission}</span>
          <br />
          <Text size="sm" tone="secondary">{PERMISSION_DESCRIPTIONS[row.permission]}</Text>
        </span>
      ),
    },
    ...(roles ?? []).map<TableColumn<MatrixRow>>((role) => ({
      id: role.id,
      header: role.name,
      align: 'center',
      accessor: (row) => (row.grants[role.id] ? 'Granted' : 'Not granted'),
      cell: (row) =>
        row.grants[role.id] ? (
          <span><Icon name="accept" color="var(--eui-color-success)" /> Yes</span>
        ) : (
          <Text tone="secondary"><span aria-hidden="true">—</span><VisuallyHidden>No</VisuallyHidden></Text>
        ),
    })),
  ];

  return (
    <Page
      title="Roles"
      subtitle="What each role may do. The server checks these permissions on every request."
      actions={
        <>
          {canWrite && <Button variant="primary" icon="add" onClick={() => setEditing({ role: null })}>Create role</Button>}
          <RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
        </>
      }
    >
      {error && <MessageStrip tone="error" title="Cannot load roles">{error}</MessageStrip>}
      <Table caption="Roles" columns={roleColumns} data={roles ?? []} getRowId={(r) => r.id} getRowLabel={(r) => r.name} loading={loading && !roles} />
      <Text as="p" size="sm" tone="secondary">
        Administrator, Operator and Viewer are built in and cannot be changed or removed. Only Administrator may hold every permission.
        {canWrite && ' You can only grant permissions you hold yourself.'}
      </Text>
      <Card title="Permission matrix" subtitle="Which permissions each role grants." headingLevel={2} noPadding>
        <Table caption="Permissions granted by each role" hideCaption columns={matrixColumns} data={roles ? matrix : []} getRowId={(r) => r.permission} loading={loading && !roles} />
      </Card>
      <RoleDialog
        open={editing !== null}
        role={editing?.role ?? null}
        template={editing?.template}
        own={own}
        onClose={() => setEditing(null)}
        onSaved={(role, created) => {
          setEditing(null);
          toast.show({ tone: 'success', title: created ? 'Role created' : 'Role saved', description: `${role.name}: ${role.permissions.length} permissions` });
          reload();
        }}
      />
      <AlertDialog open={removing !== null} tone="warning" title="Delete this role?" confirmLabel="Delete" onCancel={() => setRemoving(null)} onConfirm={confirmRemove}>
        {removing && `"${removing.name}" will be removed. Nobody holds it, so no one loses access.`}
      </AlertDialog>
    </Page>
  );
}
