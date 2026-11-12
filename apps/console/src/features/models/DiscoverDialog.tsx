import { useEffect, useMemo, useState } from 'react';
import { BusyIndicator, Button, Checkbox, Dialog, MessageStrip, SearchField, Select, StatusIndicator, Table, Text, type TableColumn } from '@enterprise-ui/react';
import type { DiscoveredModelInfo, ProviderInfo } from '@clawapi/shared';
import { discoverModels, importModels } from '../../services/models.ts';
import { formatTokens } from '../../services/format.ts';

/**
 * Model discovery (spec §9): ask a provider which models it offers and import
 * a selection. The server re-checks the list on import.
 */
export function DiscoverDialog({ open, providers, initialProviderId, onClose, onImported }: {
  open: boolean;
  providers: ProviderInfo[];
  initialProviderId?: string;
  onClose: () => void;
  onImported: (count: number, providerName: string) => void;
}) {
  const [providerId, setProviderId] = useState<string | null>(null);
  const [found, setFound] = useState<DiscoveredModelInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (open) setProviderId(initialProviderId ?? providers.find((p) => p.enabled)?.id ?? providers[0]?.id ?? null);
    else {
      setFound(null);
      setSelected(new Set());
      setError(null);
      setFilter('');
    }
  }, [open, initialProviderId, providers]);

  useEffect(() => {
    if (!open || !providerId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setFound(null);
    setSelected(new Set());
    discoverModels(providerId, controller.signal)
      .then((list) => {
        setFound(list);
        // Pre-select new chat and embedding models; leave the rest for the operator.
        setSelected(new Set(list.filter((m) => !m.registered && m.capabilities.length > 0).map((m) => m.providerModelId)));
      })
      .catch((err: unknown) => !controller.signal.aborted && setError(err instanceof Error ? err.message : 'Discovery failed.'))
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [open, providerId]);

  const visible = useMemo(() => (found ?? []).filter((m) => !filter || `${m.providerModelId} ${m.displayName ?? ''}`.toLowerCase().includes(filter.toLowerCase())), [found, filter]);
  const selectable = visible.filter((m) => !m.registered);
  const allSelected = selectable.length > 0 && selectable.every((m) => selected.has(m.providerModelId));
  const provider = providers.find((p) => p.id === providerId);

  const toggle = (id: string, on: boolean) => setSelected((s) => {
    const next = new Set(s);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });

  const submit = async () => {
    if (!providerId || !selected.size) return;
    setImporting(true);
    setError(null);
    try {
      const result = await importModels(providerId, [...selected]);
      onImported(result.imported, provider?.name ?? 'provider');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  const columns: TableColumn<DiscoveredModelInfo>[] = [
    {
      id: 'pick', header: <Checkbox aria-label="Select all new models" checked={allSelected} indeterminate={!allSelected && selectable.some((m) => selected.has(m.providerModelId))} onChange={(on) => setSelected(new Set(on ? [...selected, ...selectable.map((m) => m.providerModelId)] : [...selected].filter((id) => !selectable.some((m) => m.providerModelId === id))))} />,
      headerText: 'Select', width: '3rem',
      cell: (m) => <Checkbox aria-label={`Import ${m.providerModelId}`} disabled={m.registered} checked={m.registered || selected.has(m.providerModelId)} onChange={(on) => toggle(m.providerModelId, on)} />,
    },
    { id: 'id', header: 'Model', rowHeader: true, wrap: true, accessor: 'providerModelId', cell: (m) => <span><span className="claw-mono claw-break">{m.providerModelId}</span>{m.displayName && m.displayName !== m.providerModelId ? <><br /><Text size="sm" tone="secondary">{m.displayName}</Text></> : null}</span> },
    { id: 'caps', header: 'Detected as', accessor: (m) => m.capabilities.join(', '), cell: (m) => (m.capabilities.length ? m.capabilities.join(', ').toLowerCase() : <Text tone="secondary">other</Text>) },
    { id: 'ctx', header: 'Context', align: 'end', accessor: (m) => m.contextLength ?? 0, cell: (m) => <span className="claw-mono">{formatTokens(m.contextLength)}</span> },
    { id: 'state', header: 'Status', accessor: (m) => (m.registered ? 1 : 0), cell: (m) => (m.registered ? <StatusIndicator tone="neutral" size="sm">Registered</StatusIndicator> : <StatusIndicator tone="information" size="sm">New</StatusIndicator>) },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Discover models"
      footer={
        <>
          <Button variant="primary" disabled={!selected.size} loading={importing} onClick={() => void submit()}>
            {selected.size ? `Import ${selected.size} model${selected.size === 1 ? '' : 's'}` : 'Import'}
          </Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'end' }}>
          <Select label="Provider" value={providerId} onChange={setProviderId} options={providers.map((p) => ({ value: p.id, label: p.name, description: p.enabled ? p.identifier : `${p.identifier} (disabled)` }))} />
          <SearchField aria-label="Filter discovered models" placeholder="Filter models" value={filter} onChange={setFilter} size="sm" />
        </div>
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        {loading && <BusyIndicator active text={`Asking ${provider?.name ?? 'the provider'} for its models…`} />}
        {found && (
          <>
            <Text size="sm" tone="secondary">
              {found.length} model{found.length === 1 ? '' : 's'} offered, {found.filter((m) => m.registered).length} already registered. Capabilities are a first guess; edit them after importing.
            </Text>
            <div style={{ maxHeight: '50vh', overflow: 'auto' }}>
              <Table caption="Models offered by the provider" hideCaption columns={columns} data={visible} getRowId={(m) => m.providerModelId} emptyState="No models match." />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
