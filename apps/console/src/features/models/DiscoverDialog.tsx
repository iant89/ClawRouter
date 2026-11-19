/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

import { useEffect, useMemo, useState } from 'react';
import { Badge, BusyIndicator, Button, Checkbox, Dialog, MessageStrip, SearchField, Select, StatusIndicator, Switch, Table, Text, type SortState, type TableColumn } from '@enterprise-ui/react';
import type { DiscoveredModelInfo, ProviderInfo } from '@clawrouter/shared';
import { discoverModels, importModels } from '../../services/models.ts';
import { formatPrice, formatTokens } from '../../services/format.ts';
import { hasPrice, isFree, sortModels } from './model-price.ts';

/** Past this many models, only the visible rows are rendered (fixed row height). */
const VIRTUALIZE_FROM = 150;
const ROW_HEIGHT = 40;

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
  const [freeOnly, setFreeOnly] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);

  useEffect(() => {
    if (open) setProviderId(initialProviderId ?? providers.find((p) => p.enabled)?.id ?? providers[0]?.id ?? null);
    else {
      setFound(null);
      setSelected(new Set());
      setError(null);
      setFilter('');
      setFreeOnly(false);
      setSort(null);
    }
  }, [open, initialProviderId, providers]);

  useEffect(() => {
    if (!open || !providerId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setFound(null);
    setSelected(new Set());
    setFreeOnly(false);
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

  const visible = useMemo(() => sortModels((found ?? []).filter((m) => (!filter || `${m.providerModelId} ${m.displayName ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
    && (!freeOnly || isFree(m.cost))), sort), [found, filter, freeOnly, sort]);
  const freeCount = useMemo(() => (found ?? []).filter((m) => isFree(m.cost)).length, [found]);
  const priced = useMemo(() => (found ?? []).some((m) => hasPrice(m.cost)), [found]);
  // Phase 16: a provider can offer hundreds of models.
  const many = visible.length > VIRTUALIZE_FROM;
  const selectable = visible.filter((m) => !m.registered);
  const allSelected = selectable.length > 0 && selectable.every((m) => selected.has(m.providerModelId));
  const provider = providers.find((p) => p.id === providerId);
  // Only what is checked and on screen is imported: a filter or "Free only" never imports models it hides.
  const toImport = useMemo(() => visible.filter((m) => !m.registered && selected.has(m.providerModelId)).map((m) => m.providerModelId), [visible, selected]);
  const hiddenSelected = selected.size - toImport.length;

  const toggle = (id: string, on: boolean) => setSelected((s) => {
    const next = new Set(s);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });

  const submit = async () => {
    if (!providerId || !toImport.length) return;
    setImporting(true);
    setError(null);
    try {
      const result = await importModels(providerId, toImport);
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
    many
      // Long lists are windowed (fixed row height): one line per model, the id only so every column fits; the name on hover.
      ? { id: 'id', header: 'Model', rowHeader: true, sortable: true, accessor: 'providerModelId', cell: (m) => <span className="claw-mono" title={m.displayName ?? m.providerModelId}>{m.providerModelId}</span> }
      : { id: 'id', header: 'Model', rowHeader: true, sortable: true, wrap: true, accessor: 'providerModelId', cell: (m) => <span><span className="claw-mono claw-break">{m.providerModelId}</span>{m.displayName && m.displayName !== m.providerModelId ? <><br /><Text size="sm" tone="secondary">{m.displayName}</Text></> : null}</span> },
    { id: 'caps', header: 'Detected as', accessor: (m) => m.capabilities.join(', '), cell: (m) => (m.capabilities.length ? m.capabilities.join(', ').toLowerCase() : <Text tone="secondary">other</Text>) },
    { id: 'ctx', header: 'Context', align: 'end', sortable: true, accessor: (m) => m.contextLength ?? 0, cell: (m) => <span className="claw-mono">{formatTokens(m.contextLength)}</span> },
    // Only for providers that publish prices (Groq, OpenRouter): per million tokens, input · output.
    ...(priced ? [{
      id: 'price', header: 'Price / 1M', headerText: 'Price per million tokens (input · output)', align: 'end' as const, sortable: true, accessor: (m: DiscoveredModelInfo) => (m.cost?.inputPerMTok ?? 0) + (m.cost?.outputPerMTok ?? 0),
      cell: (m: DiscoveredModelInfo) => (isFree(m.cost)
        ? <Badge tone="success">Free</Badge>
        : hasPrice(m.cost)
          ? <span className="claw-mono" title="Per million tokens: input · output">{formatPrice(m.cost!.inputPerMTok)} · {formatPrice(m.cost!.outputPerMTok)}</span>
          : <Text tone="secondary" title="This provider does not publish a price for this model">—</Text>),
    }] : []),
    { id: 'state', header: 'Status', accessor: (m) => (m.registered ? 1 : 0), cell: (m) => (m.registered ? <StatusIndicator tone="neutral" size="sm">Registered</StatusIndicator> : <StatusIndicator tone="information" size="sm">New</StatusIndicator>) },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size={priced ? 'xl' : 'lg'}
      title="Discover models"
      footer={
        <>
          <Button variant="primary" disabled={!toImport.length} loading={importing} onClick={() => void submit()}>
            {toImport.length ? `Import ${toImport.length} model${toImport.length === 1 ? '' : 's'}` : 'Import'}
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
        {freeCount > 0 && <Switch label={`Free only (${freeCount})`} checked={freeOnly} onChange={setFreeOnly} />}
        {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
        {loading && <BusyIndicator active text={`Asking ${provider?.name ?? 'the provider'} for its models…`} />}
        {found && (
          <>
            <Text size="sm" tone="secondary">
              {found.length} model{found.length === 1 ? '' : 's'} offered, {found.filter((m) => m.registered).length} already registered. Capabilities are a first guess; edit them after importing.
              {hiddenSelected > 0 && ` ${hiddenSelected} selected model${hiddenSelected === 1 ? ' is' : 's are'} hidden by the filter and will not be imported.`}
            </Text>
            {many ? (
              <Table caption="Models offered by the provider" hideCaption columns={columns} data={visible} getRowId={(m) => m.providerModelId} emptyState="No models match."
                sort={sort} onSortChange={setSort} manualSorting virtualization={{ rowHeight: ROW_HEIGHT, height: 440, overscan: 8 }} />
            ) : (
              <div style={{ maxHeight: '50vh', overflow: 'auto' }}>
                <Table caption="Models offered by the provider" hideCaption columns={columns} data={visible} getRowId={(m) => m.providerModelId} emptyState="No models match."
                  sort={sort} onSortChange={setSort} manualSorting />
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
