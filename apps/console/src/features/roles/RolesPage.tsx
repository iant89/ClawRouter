import { Card, Icon, MessageStrip, Page, RefreshControl, Table, Text, VisuallyHidden, type TableColumn } from '@enterprise-ui/react';
import { PERMISSION_DESCRIPTIONS, PERMISSIONS, type Permission, type RoleInfo } from '@clawapi/shared';
import { useResource } from '../../hooks/useResource.ts';
import { fetchRoles } from '../../services/access.ts';

interface MatrixRow {
  permission: Permission;
  grants: Record<string, boolean>;
}

/** Administration → Roles: what each role may do. Built-in roles are fixed. */
export function RolesPage() {
  const { data: roles, error, loading, lastUpdated, reload } = useResource(fetchRoles);

  const roleColumns: TableColumn<RoleInfo>[] = [
    { id: 'name', header: 'Role', rowHeader: true, accessor: 'name', cell: (r) => <span>{r.name} <Text size="sm" tone="secondary">({r.id})</Text></span> },
    { id: 'description', header: 'Description', accessor: 'description', wrap: true },
    { id: 'permissions', header: 'Permissions', align: 'end', accessor: (r) => r.permissions.length, cell: (r) => <span className="claw-mono">{r.permissions.length}</span> },
    { id: 'members', header: 'Users', align: 'end', accessor: 'memberCount', cell: (r) => <span className="claw-mono">{r.memberCount}</span> },
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
      actions={<RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />}
    >
      {error && <MessageStrip tone="error" title="Cannot load roles">{error}</MessageStrip>}
      <Table caption="Roles" columns={roleColumns} data={roles ?? []} getRowId={(r) => r.id} loading={loading && !roles} />
      <Card title="Permission matrix" subtitle="Built-in roles are fixed. Custom roles are planned." headingLevel={2} noPadding>
        <Table caption="Permissions granted by each role" hideCaption columns={matrixColumns} data={roles ? matrix : []} getRowId={(r) => r.permission} loading={loading && !roles} />
      </Card>
    </Page>
  );
}
