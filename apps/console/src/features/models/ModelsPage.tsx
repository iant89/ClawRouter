import { useEffect, useMemo, useState } from 'react';
import {
  AlertDialog, Button, Checkbox, FilterBar, MessageStrip, OverflowMenu, Page, Pagination, RefreshControl, SearchField, Select, Table, Text, useToast,
  type TableColumn,
} from '@enterprise-ui/react';
import { CAPABILITIES, type Capability, type ModelInfo, type ProviderInfo } from '@clawapi/shared';
import { ModelAvailability } from '../../components/custom/ModelAvailability.tsx';
import { ProviderStatus } from '../../components/custom/ProviderStatus.tsx';
import { useRouter } from '../../app/router.tsx';
import type { PagedResult } from '../../services/api-client.ts';
import { formatPrice, formatTokens } from '../../services/format.ts';
import { deleteModel, fetchModels, updateModel } from '../../services/models.ts';
import { fetchProviders } from '../../services/providers.ts';
import { usePermissions } from '../auth/AuthContext.tsx';
import { DiscoverDialog } from './DiscoverDialog.tsx';
import { CAPABILITY_LABEL, ModelDialog } from './ModelDialog.tsx';

const PAGE_SIZE = 25;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** AI Infrastructure → Models: the model registry (spec §9). Filtering and paging happen on the server. */
export function ModelsPage() {
  const toast = useToast();
  const { search: query, navigate, pathname } = useRouter();
  const canWrite = usePermissions().can('models.write');
  const initial = useMemo(() => new URLSearchParams(query), [query]);

  const [providerId, setProviderId] = useState<string | null>(initial.get('provider'));
  const [capability, setCapability] = useState<Capability | null>(null);
  const [usableOnly, setUsableOnly] = useState(false);
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [result, setResult] = useState<PagedResult<ModelInfo> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();

  const [editing, setEditing] = useState<ModelInfo | null>(null);
  const [adding, setAdding] = useState(false);
  const [discovering, setDiscovering] = useState(initial.get('discover') === '1');
  const [deleting, setDeleting] = useState<ModelInfo | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchProviders(controller.signal).then(setProviders).catch(() => {});
    return () => controller.abort();
  }, [reloadKey]);

  // Any filter change starts again at page 1.
  useEffect(() => setPage(1), [providerId, capability, usableOnly, q]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchModels({ page, pageSize: PAGE_SIZE, providerId: providerId ?? undefined, capability: capability ?? undefined, q: q || undefined, usableOnly }, controller.signal)
      .then((r) => {
        setResult(r);
        setError(null);
        setLastUpdated(new Date());
      })
      .catch((err: unknown) => !controller.signal.aborted && setError(err instanceof Error ? err.message : 'Could not load models.'))
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [page, providerId, capability, usableOnly, q, reloadKey]);

  // The ?discover=1 shortcut from the Providers page is consumed once.
  useEffect(() => {
    if (initial.get('discover') === '1') navigate(`${pathname}${providerId ? `?provider=${encodeURIComponent(providerId)}` : ''}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeFilters = Number(!!providerId) + Number(!!capability) + Number(usableOnly) + Number(!!q);

  const toggle = async (m: ModelInfo) => {
    try {
      await updateModel(m.id, { enabled: !m.enabled });
      toast.show({ tone: 'success', title: `${m.displayName} ${m.enabled ? 'disabled' : 'enabled'}` });
    } catch (err) {
      toast.show({ tone: 'error', duration: 10_000, title: 'Could not change the model', description: err instanceof Error ? err.message : undefined });
    }
    reload();
  };

  const columns: TableColumn<ModelInfo>[] = [
    {
      id: 'model', header: 'Model', rowHeader: true, wrap: true, accessor: 'displayName',
      cell: (m) => <span>{m.displayName}<br /><Text size="sm" tone="secondary"><span className="claw-mono claw-break">{m.ref}</span></Text></span>,
    },
    { id: 'provider', header: 'Provider', wrap: true, accessor: (m) => m.provider.name, cell: (m) => <span>{m.provider.name}<br /><ProviderStatus state={m.provider.status} size="sm" /></span> },
    { id: 'caps', header: 'Capabilities', wrap: true, accessor: (m) => m.capabilities.join(', '), cell: (m) => (m.capabilities.length ? m.capabilities.map((c) => CAPABILITY_LABEL[c]).join(', ') : <Text tone="secondary">None</Text>) },
    { id: 'ctx', header: 'Context', align: 'end', accessor: (m) => m.contextLength ?? 0, cell: (m) => <span className="claw-mono" title={m.maxOutputTokens ? `Max output ${m.maxOutputTokens.toLocaleString()} tokens` : undefined}>{formatTokens(m.contextLength)}</span> },
    {
      id: 'price', header: 'Price / 1M (in · out)', align: 'end', accessor: (m) => m.cost?.inputPerMTok ?? -1,
      cell: (m) => (m.cost ? <span className="claw-mono">{formatPrice(m.cost.inputPerMTok)} · {formatPrice(m.cost.outputPerMTok)}</span> : <Text tone="secondary">—</Text>),
    },
    { id: 'state', header: 'Availability', wrap: true, accessor: (m) => (m.usable ? 0 : 1), cell: (m) => <ModelAvailability model={m} /> },
    ...(canWrite
      ? [{
          id: 'actions', header: 'Actions', align: 'end' as const,
          cell: (m: ModelInfo) => (
            <OverflowMenu
              label={`Actions for ${m.displayName}`}
              items={[
                { id: 'edit', label: 'Edit' },
                { id: 'toggle', label: m.enabled ? 'Disable' : 'Enable' },
                { type: 'separator' as const },
                { id: 'delete', label: 'Delete', destructive: true },
              ]}
              onAction={(id) => {
                if (id === 'edit') setEditing(m);
                if (id === 'toggle') void toggle(m);
                if (id === 'delete') setDeleting(m);
              }}
            />
          ),
        }]
      : []),
  ];

  const total = result?.total ?? 0;
  return (
    <Page
      title="Models"
      subtitle="Models ClawAPI can route requests to. Availability combines the model and its provider."
      actions={
        <>
          <RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />
          {canWrite && <Button variant="tertiary" disabled={!providers.length} onClick={() => setAdding(true)}>Add manually</Button>}
          {canWrite && <Button variant="primary" icon="search" disabled={!providers.length} onClick={() => setDiscovering(true)}>Discover models</Button>}
        </>
      }
    >
      <FilterBar
        liveMode
        title="Model filters"
        search={<SearchField aria-label="Search models" placeholder="Search by name or id" size="sm" value={text} onChange={setText} />}
        activeCount={activeFilters}
        onClear={() => {
          setProviderId(null);
          setCapability(null);
          setUsableOnly(false);
          setText('');
        }}
      >
        <Select label="Provider" placeholder="All providers" size="sm" value={providerId} onChange={setProviderId} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
        <Select label="Capability" placeholder="Any capability" size="sm" value={capability} onChange={(v) => setCapability(v as Capability | null)} options={CAPABILITIES.map((c) => ({ value: c, label: CAPABILITY_LABEL[c] }))} />
        <Checkbox label="Usable only" checked={usableOnly} onChange={setUsableOnly} />
      </FilterBar>
      {error && <MessageStrip tone="error" title="Cannot load models">{error}</MessageStrip>}
      {!providers.length && !loading && <MessageStrip tone="information">Add a provider first: models belong to providers.</MessageStrip>}
      <Table
        caption={`Models (${total})`}
        columns={columns}
        data={result?.items ?? []}
        getRowId={(m) => m.id}
        getRowLabel={(m) => m.displayName}
        loading={loading && !result}
        emptyState={activeFilters ? 'No models match these filters.' : canWrite ? 'No models yet. Use "Discover models" to import them from a provider.' : 'No models yet.'}
      />
      {total > PAGE_SIZE && <Pagination page={page} onPageChange={setPage} totalItems={total} pageSize={PAGE_SIZE} />}

      <ModelDialog
        open={adding || editing !== null}
        model={editing}
        providers={providers}
        onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={(m, created) => {
          setAdding(false);
          setEditing(null);
          toast.show({ tone: 'success', title: created ? `${m.displayName} added` : `${m.displayName} saved` });
          reload();
        }}
      />
      <DiscoverDialog
        open={discovering}
        providers={providers}
        initialProviderId={providerId ?? undefined}
        onClose={() => setDiscovering(false)}
        onImported={(count, name) => {
          setDiscovering(false);
          toast.show({ tone: 'success', title: `${count} model${count === 1 ? '' : 's'} imported from ${name}` });
          reload();
        }}
      />
      <AlertDialog
        open={deleting !== null}
        tone="error"
        title={`Delete ${deleting?.displayName ?? 'model'}?`}
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteModel(deleting.id);
            toast.show({ tone: 'success', title: `${deleting.displayName} deleted` });
          } catch (err) {
            toast.show({ tone: 'error', duration: 10_000, title: 'Could not delete the model', description: err instanceof Error ? err.message : undefined });
          }
          setDeleting(null);
          reload();
        }}
      >
        It is removed from the registry. If the provider still offers it, you can import it again later.
      </AlertDialog>
    </Page>
  );
}
