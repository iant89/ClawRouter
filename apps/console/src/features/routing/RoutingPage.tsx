import { useEffect, useMemo, useState } from 'react';
import {
  AlertDialog, Button, Card, Dialog, MessageStrip, OverflowMenu, Page, RefreshControl, StatusIndicator, Table, Text, useToast, type TableColumn,
} from '@enterprise-ui/react';
import type { ModelAlias, ModelInfo, PutRoutingRequest, RoutingConfigView, RoutingPolicy } from '@clawrouter/shared';
import { useResource } from '../../hooks/useResource.ts';
import { ApiClientError } from '../../services/api-client.ts';
import { fetchModels } from '../../services/models.ts';
import { fetchRouting, saveRouting } from '../../services/routing.ts';
import { usePermissions } from '../auth/AuthContext.tsx';
import { CAPABILITY_LABEL } from '../models/ModelDialog.tsx';
import { AliasDialog } from './AliasDialog.tsx';
import { PolicyFields } from './PolicyFields.tsx';
import { RouteTester } from './RouteTester.tsx';
import { describePolicy, summarizeTargets, withAlias, withDefaultPolicy } from './routing-utils.ts';

/** Model choices for alias targets: the first 200 by provider priority (enough until the registry needs search here). */
const loadModels = async (signal: AbortSignal) => (await fetchModels({ page: 1, pageSize: 200 }, signal)).items;

/** AI Infrastructure → Routing: aliases, fallback order, weights and failover policy (spec §10, §11). */
export function RoutingPage() {
  const toast = useToast();
  const canWrite = usePermissions().can('routing.write');
  const { data: config, error, loading, lastUpdated, reload } = useResource(fetchRouting);
  const { data: models } = useResource(loadModels);

  const [editing, setEditing] = useState<ModelAlias | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ModelAlias | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyDraft, setPolicyDraft] = useState<RoutingPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testModel, setTestModel] = useState<{ name: string; key: number } | null>(null);

  useEffect(() => {
    if (policyOpen && config) setPolicyDraft(config.defaultPolicy);
  }, [policyOpen, config]);

  /** Saves a whole new configuration; a version conflict reloads so the user can re-apply. */
  const save = async (body: PutRoutingRequest, success: string): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    try {
      await saveRouting(body);
      toast.show({ tone: 'success', title: success });
      reload();
      return true;
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        toast.show({ tone: 'warning', duration: 10_000, title: 'Routing was changed by someone else', description: 'The latest version has been loaded. Apply your change again.' });
        reload();
        return true;
      }
      const message = err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : err instanceof Error ? err.message : 'Could not save.';
      setSaveError(message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const problemsByAlias = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of config?.problems ?? []) map.set(p.alias, [...(map.get(p.alias) ?? []), p.message]);
    return map;
  }, [config]);

  const columns: TableColumn<ModelAlias>[] = [
    {
      id: 'name', header: 'Alias', rowHeader: true, wrap: true, accessor: 'name',
      cell: (a) => <span><span className="claw-mono">{a.name}</span>{a.description ? <><br /><Text size="sm" tone="secondary">{a.description}</Text></> : null}</span>,
    },
    { id: 'targets', header: 'Targets (in order)', wrap: true, accessor: (a) => summarizeTargets(a), cell: (a) => <span className="claw-mono claw-break">{summarizeTargets(a)}</span> },
    { id: 'caps', header: 'Requires', wrap: true, accessor: (a) => a.capabilities.join(', '), cell: (a) => (a.capabilities.length ? a.capabilities.map((c) => CAPABILITY_LABEL[c]).join(', ') : <Text tone="secondary">—</Text>) },
    { id: 'policy', header: 'Policy', wrap: true, minWidth: '7rem', accessor: (a) => (a.policy ? 1 : 0), cell: (a) => (a.policy ? describePolicy(a.policy) : <Text tone="secondary">Default</Text>) },
    {
      id: 'status', header: 'Status', wrap: true, accessor: (a) => (a.enabled ? 0 : 1),
      cell: (a) => {
        const problems = problemsByAlias.get(a.name) ?? [];
        if (!a.enabled) return <StatusIndicator tone="neutral" size="sm">Disabled</StatusIndicator>;
        if (problems.length) return <span title={problems.join('\n')}><StatusIndicator tone="warning" size="sm">{problems[0]!}</StatusIndicator></span>;
        return <StatusIndicator tone="success" size="sm">Routable</StatusIndicator>;
      },
    },
    {
      id: 'actions', header: 'Actions', align: 'end',
      cell: (a) => (
        <OverflowMenu
          label={`Actions for ${a.name}`}
          items={[
            { id: 'test', label: 'Test route' },
            ...(canWrite
              ? [
                  { id: 'edit', label: 'Edit' },
                  { id: 'toggle', label: a.enabled ? 'Disable' : 'Enable' },
                  { type: 'separator' as const },
                  { id: 'delete', label: 'Delete', destructive: true },
                ]
              : []),
          ]}
          onAction={(id) => {
            if (id === 'test') setTestModel({ name: a.name, key: Date.now() });
            if (id === 'edit') setEditing(a);
            if (id === 'toggle' && config) void save(withAlias(config, { ...a, enabled: !a.enabled }, a.name), `${a.name} ${a.enabled ? 'disabled' : 'enabled'}`);
            if (id === 'delete') setDeleting(a);
          }}
        />
      ),
    },
  ];

  const otherNames = (except: string | null) => new Set((config?.aliases ?? []).filter((a) => a.name !== except).map((a) => a.name.toLowerCase()));

  return (
    <Page
      title="Routing"
      subtitle="Aliases clients can request, the models behind them in fallback order, and what happens when a model fails."
      actions={
        <>
          <RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
          {canWrite && <Button variant="primary" icon="add" disabled={!config} onClick={() => setAdding(true)}>Add alias</Button>}
        </>
      }
    >
      {error && <MessageStrip tone="error" title="Cannot load routing">{error}</MessageStrip>}
      {config && config.problems.length > 0 && (
        <MessageStrip tone="warning" title={`${config.problems.length} routing problem${config.problems.length === 1 ? '' : 's'}`}>
          <ul style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
            {config.problems.map((p, i) => <li key={i}><span className="claw-mono">{p.alias}</span>: {p.message}</li>)}
          </ul>
        </MessageStrip>
      )}

      <Card
        title="Default failover policy"
        subtitle="Used by requests for a model reference or model id, and by aliases without their own policy."
        headingLevel={2}
        headerActions={canWrite && config ? <Button size="sm" variant="tertiary" onClick={() => setPolicyOpen(true)}>Edit</Button> : undefined}
      >
        <Text>{config ? describePolicy(config.defaultPolicy) : '…'}</Text>
        {config?.updatedAt && <Text as="p" size="sm" tone="secondary">Version {config.version}, saved {new Date(config.updatedAt).toLocaleString()}.</Text>}
      </Card>

      <Table
        caption={`Aliases (${config?.aliases.length ?? 0})`}
        columns={columns}
        data={config?.aliases ?? []}
        getRowId={(a) => a.name}
        getRowLabel={(a) => a.name}
        loading={loading && !config}
        emptyState={canWrite ? 'No aliases yet. Clients can still request a model by reference (openai/gpt-4o) or model id (gpt-4o). Add an alias for fallback and weighting.' : 'No aliases yet.'}
      />

      <RouteTester key={testModel?.key ?? 0} initialModel={testModel?.name ?? ''} />

      <AliasDialog
        open={adding || editing !== null}
        alias={editing}
        models={(models ?? []) as ModelInfo[]}
        existingNames={otherNames(editing?.name ?? null)}
        saving={saving}
        serverError={saveError}
        onClose={() => { setAdding(false); setEditing(null); setSaveError(null); }}
        onSave={async (alias) => {
          if (!config) return;
          const done = await save(withAlias(config, alias, editing?.name ?? null), editing ? `${alias.name} saved` : `${alias.name} added`);
          if (done) { setAdding(false); setEditing(null); }
        }}
      />

      <Dialog
        open={policyOpen}
        onClose={() => setPolicyOpen(false)}
        title="Default failover policy"
        footer={
          <>
            <Button variant="primary" loading={saving} onClick={async () => {
              if (config && policyDraft && (await save(withDefaultPolicy(config as RoutingConfigView, policyDraft), 'Default policy saved'))) setPolicyOpen(false);
            }}>Save</Button>
            <Button variant="tertiary" onClick={() => setPolicyOpen(false)}>Cancel</Button>
          </>
        }
      >
        {saveError && <MessageStrip tone="error">{saveError}</MessageStrip>}
        {policyDraft && <PolicyFields value={policyDraft} onChange={setPolicyDraft} />}
        <Text as="p" size="sm" tone="secondary">A request never makes more than 10 attempts, whatever is configured.</Text>
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        tone="error"
        title={`Delete alias ${deleting?.name ?? ''}?`}
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (config && deleting) await save(withAlias(config, null, deleting.name), `${deleting.name} deleted`);
          setDeleting(null);
        }}
      >
        Clients requesting "{deleting?.name}" will get an "unknown model" error.
      </AlertDialog>
    </Page>
  );
}
