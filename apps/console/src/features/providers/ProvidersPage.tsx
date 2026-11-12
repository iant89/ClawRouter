import { useEffect, useMemo, useState } from 'react';
import {
  AlertDialog, Button, MessageStrip, OverflowMenu, Page, RefreshControl, Table, Text, useToast, type TableColumn,
} from '@enterprise-ui/react';
import type { ProviderInfo, ProviderKindInfo } from '@clawapi/shared';
import { ProviderStatus } from '../../components/custom/ProviderStatus.tsx';
import { EmptyStateFor } from './EmptyStateFor.tsx';
import { useResource } from '../../hooks/useResource.ts';
import { formatRelative } from '../../services/format.ts';
import { deleteProvider, fetchProviderKinds, fetchProviders, testProvider, updateProvider } from '../../services/providers.ts';
import { usePermissions } from '../auth/AuthContext.tsx';
import { useRouter } from '../../app/router.tsx';
import { ProviderDialog } from './ProviderDialog.tsx';
import { ProviderHistoryDialog } from './ProviderHistoryDialog.tsx';

const loadAll = async (signal: AbortSignal) => {
  const [providers, kinds] = await Promise.all([fetchProviders(signal), fetchProviderKinds(signal)]);
  return { providers, kinds };
};

/** Background health checks update status on the server; the page refreshes to show them. */
const REFRESH_MS = 30_000;

/** AI Infrastructure → Providers (spec §8, §17). */
export function ProvidersPage() {
  const toast = useToast();
  const { can } = usePermissions();
  const canWrite = can('providers.write');
  const canDiscover = can('models.write');
  const { navigate } = useRouter();
  const { data, error, loading, lastUpdated, reload } = useResource(loadAll);
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState<ProviderInfo | null>(null);
  const [deleting, setDeleting] = useState<ProviderInfo | null>(null);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const kindName = useMemo(() => new Map((data?.kinds ?? []).map((k: ProviderKindInfo) => [k.kind, k.displayName])), [data]);

  useEffect(() => {
    const id = window.setInterval(() => document.visibilityState === 'visible' && reload(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  const runTest = async (p: ProviderInfo) => {
    setTesting((s) => new Set(s).add(p.id));
    try {
      const r = await testProvider(p.id);
      // Timed even for failures: the result also stays visible in the provider's row.
      toast.show({
        duration: 10_000,
        tone: r.ok ? (r.status === 'DEGRADED' ? 'warning' : 'success') : 'error',
        title: r.ok ? `${p.name}: connected` : `${p.name}: connection failed`,
        description: r.ok && r.sampleModels.length ? `${r.message} e.g. ${r.sampleModels.slice(0, 3).join(', ')}` : r.message,
      });
    } catch (err) {
      toast.show({ duration: 10_000, tone: 'error', title: `${p.name}: test failed`, description: err instanceof Error ? err.message : undefined });
    } finally {
      setTesting((s) => {
        const next = new Set(s);
        next.delete(p.id);
        return next;
      });
      reload();
    }
  };

  const toggle = async (p: ProviderInfo) => {
    try {
      await updateProvider(p.id, { enabled: !p.enabled });
      toast.show({ tone: 'success', title: `${p.name} ${p.enabled ? 'disabled' : 'enabled'}` });
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not change the provider', description: err instanceof Error ? err.message : undefined });
    }
    reload();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteProvider(deleting.id);
      toast.show({ tone: 'success', title: `${deleting.name} deleted` });
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not delete the provider', description: err instanceof Error ? err.message : undefined });
    }
    setDeleting(null);
    reload();
  };

  const columns: TableColumn<ProviderInfo>[] = [
    {
      id: 'name', header: 'Provider', rowHeader: true, sortable: true, accessor: 'name', wrap: true,
      cell: (p) => <span>{p.name}<br /><Text size="sm" tone="secondary"><span className="claw-mono">{p.identifier}</span> · {kindName.get(p.kind) ?? p.kind}</Text></span>,
    },
    {
      id: 'status', header: 'Status', sortable: true, accessor: 'status', wrap: true,
      cell: (p) => (
        <span title={p.statusDetail ?? undefined}>
          <ProviderStatus state={p.status} size="sm" />
          <br />
          <Text size="sm" tone="secondary">{p.statusCheckedAt ? `${formatRelative(p.statusCheckedAt)}${p.latencyMs !== null ? ` · ${p.latencyMs} ms` : ''}` : (p.statusDetail ?? '')}</Text>
        </span>
      ),
    },
    { id: 'endpoint', header: 'Endpoint', accessor: 'endpoint', wrap: true, minWidth: '12rem', cell: (p) => <span className="claw-mono claw-break">{p.endpoint}</span> },
    { id: 'priority', header: 'Priority', align: 'end', sortable: true, accessor: 'priority', cell: (p) => <span className="claw-mono">{p.priority}</span> },
    {
      id: 'key', header: 'API key', wrap: true, accessor: (p) => (p.credential.configured ? 1 : 0),
      cell: (p) => p.credential.configured
        ? <span>Stored{p.credential.hint ? <> <span className="claw-mono">…{p.credential.hint}</span></> : null}</span>
        : <Text tone="secondary">{(data?.kinds.find((k) => k.kind === p.kind)?.apiKeyRequired ?? true) ? 'Not set' : 'Not needed'}</Text>,
    },
    {
      id: 'actions', header: 'Actions', align: 'end',
      cell: (p) => (
        <span style={{ display: 'inline-flex', gap: 'var(--eui-space-1, 0.25rem)', alignItems: 'center' }}>
          {canWrite && <Button size="sm" variant="tertiary" loading={testing.has(p.id)} onClick={() => void runTest(p)}>Test</Button>}
          <OverflowMenu
            label={`More actions for ${p.name}`}
            items={[
              { id: 'history', label: 'Details and history' },
              { id: 'models', label: 'View models' },
              ...(canDiscover ? [{ id: 'discover', label: 'Discover models' }] : []),
              ...(canWrite
                ? [
                    { id: 'edit', label: 'Edit' },
                    { id: 'toggle', label: p.enabled ? 'Disable' : 'Enable' },
                    { type: 'separator' as const },
                    { id: 'delete', label: 'Delete', destructive: true },
                  ]
                : []),
            ]}
            onAction={(id) => {
              if (id === 'history') setHistory(p);
              if (id === 'models') navigate(`/models?provider=${encodeURIComponent(p.id)}`);
              if (id === 'discover') navigate(`/models?provider=${encodeURIComponent(p.id)}&discover=1`);
              if (id === 'edit') setEditing(p);
              if (id === 'toggle') void toggle(p);
              if (id === 'delete') setDeleting(p);
            }}
          />
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Providers"
      subtitle="AI providers ClawAPI can send requests to. API keys are stored encrypted and never shown again."
      actions={
        <>
          <RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
          {canWrite && <Button variant="primary" icon="add" disabled={!data} onClick={() => setCreating(true)}>Add provider</Button>}
        </>
      }
    >
      {error && <MessageStrip tone="error" title="Cannot load providers">{error}</MessageStrip>}
      <Table
        caption="Providers"
        columns={columns}
        data={data?.providers ?? []}
        getRowId={(p) => p.id}
        getRowLabel={(p) => p.name}
        loading={loading && !data}
        emptyState={<EmptyStateFor canWrite={canWrite} onAdd={() => setCreating(true)} />}
      />
      <ProviderDialog
        open={creating || editing !== null}
        provider={editing}
        kinds={data?.kinds ?? []}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={(saved, created, keyProvided) => {
          setCreating(false);
          setEditing(null);
          toast.show({ tone: 'success', title: created ? `${saved.name} added` : `${saved.name} saved` });
          reload();
          // Check new or re-keyed providers right away, so the status is real rather than "not checked".
          const needsKey = data?.kinds.find((k) => k.kind === saved.kind)?.apiKeyRequired ?? true;
          if (saved.enabled && (created || keyProvided) && (!needsKey || saved.credential.configured)) void runTest(saved);
        }}
      />
      <ProviderHistoryDialog provider={history} onClose={() => setHistory(null)} />
      <AlertDialog
        open={deleting !== null}
        tone="error"
        title={`Delete ${deleting?.name ?? 'provider'}?`}
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      >
        The provider and its stored API key are removed permanently. Requests can no longer be routed to it.
      </AlertDialog>
    </Page>
  );
}
