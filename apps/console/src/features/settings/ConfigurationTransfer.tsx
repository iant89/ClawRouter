import { useState } from 'react';
import { AlertDialog, Button, Card, Checkbox, FileUploader, MessageStrip, StatusIndicator, Table, Text, useToast, type TableColumn } from '@enterprise-ui/react';
import { CONFIGURATION_SECTIONS, type ConfigurationSection, type ImportChange, type ImportPlan, type ImportResult } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { applyImport, exportConfiguration, previewImport } from '../../services/configuration.ts';

const SECTION: Record<ConfigurationSection, string> = {
  roles: 'Roles', providers: 'Providers', models: 'Models', routing: 'Routing', rateLimits: 'Rate limits', settings: 'Settings',
};
const ACTION: Record<ImportChange['action'], { label: string; tone: 'success' | 'information' | 'neutral' | 'warning' }> = {
  create: { label: 'Create', tone: 'success' }, update: { label: 'Update', tone: 'information' }, unchanged: { label: 'Unchanged', tone: 'neutral' }, skipped: { label: 'Skipped', tone: 'warning' },
};

const columns: TableColumn<ImportChange>[] = [
  { id: 'section', header: 'Section', accessor: (c) => SECTION[c.section] },
  { id: 'name', header: 'Item', rowHeader: true, accessor: 'name', cell: (c) => <span className="claw-mono">{c.name}</span> },
  { id: 'action', header: 'Change', accessor: 'action', cell: (c) => <StatusIndicator tone={ACTION[c.action].tone} size="sm">{ACTION[c.action].label}</StatusIndicator> },
  { id: 'detail', header: 'Details', wrap: true, accessor: (c) => `${c.fields?.join(', ') ?? ''} ${c.note ?? ''}`, cell: (c) => (
    <span>
      {c.fields?.length ? <Text size="sm">{c.fields.join(', ')}</Text> : null}
      {c.note ? <Text as="p" size="sm" tone="secondary">{c.note}</Text> : null}
    </span>
  ) },
];

const message = (err: unknown) => (err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => `${i.path} ${i.message}`).join('; ') : err instanceof Error ? err.message : 'Something went wrong.');

/**
 * Settings → Configuration (phase 17): download this server's configuration, or
 * load one exported elsewhere. An import is previewed first and merges: it never
 * deletes, and never carries secrets.
 */
export function ConfigurationTransfer({ canImport }: { canImport: boolean }) {
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const [doc, setDoc] = useState<{ name: string; value: unknown } | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const download = async () => {
    setExporting(true);
    try {
      const exported = await exportConfiguration();
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `clawrouter-configuration-${exported.exportedAt.slice(0, 10)}.json` });
      a.click();
      URL.revokeObjectURL(url);
      toast.show({ tone: 'success', title: 'Configuration exported', description: `${exported.providers.length} providers, ${exported.models.length} models, ${exported.routing.aliases.length} aliases. No secrets are included.` });
    } catch (err) {
      toast.show({ tone: 'error', title: 'Cannot export', description: message(err), duration: 10_000 });
    } finally {
      setExporting(false);
    }
  };

  const load = async (file: File) => {
    setPlan(null);
    setResult(null);
    setError(null);
    let value: unknown;
    try {
      value = JSON.parse(await file.text());
    } catch {
      setError(`${file.name} is not a JSON file.`);
      throw new Error('not JSON');
    }
    try {
      setPlan(await previewImport(value));
      setDoc({ name: file.name, value });
    } catch (err) {
      setError(message(err));
      throw err;
    }
  };

  const apply = async () => {
    if (!doc) return;
    setConfirming(false);
    setApplying(true);
    try {
      const done = await applyImport(doc.value);
      setResult(done);
      setPlan(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setApplying(false);
    }
  };

  const pending = plan ? plan.changes.filter((c) => c.action === 'create' || c.action === 'update').length : 0;
  const shown = plan ? plan.changes.filter((c) => showUnchanged || c.action !== 'unchanged') : [];
  const followUps = (result ?? plan)?.changes.filter((c) => c.note && c.action !== 'unchanged') ?? [];

  return (
    <Card title="Configuration" subtitle="Providers, models, routing, rate limits, custom roles and settings as one file, to copy a setup to another server or keep it under version control. Never includes secrets: provider API keys and the mail password are entered again after an import." headingLevel={2}>
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        <div><Button variant="secondary" icon="download" onClick={() => void download()} loading={exporting}>Export configuration</Button></div>
        {canImport && (
          <>
            <FileUploader label="Import a configuration file" accept={['.json', 'application/json']} multiple={false} maxFileSize={20 * 1024 * 1024} upload={(file) => load(file)} />
            {error && <MessageStrip tone="error" title="Cannot import this file" announce="assertive">{error}</MessageStrip>}
            {plan && doc && (
              <>
                <Text as="p">
                  Importing <span className="claw-mono">{doc.name}</span> would make {pending} change{pending === 1 ? '' : 's'}:{' '}
                  {CONFIGURATION_SECTIONS.filter((s) => plan.counts[s].create || plan.counts[s].update).map((s) => `${SECTION[s]} ${plan.counts[s].create ? `+${plan.counts[s].create}` : ''}${plan.counts[s].create && plan.counts[s].update ? ' ' : ''}${plan.counts[s].update ? `~${plan.counts[s].update}` : ''}`).join(' · ') || 'nothing'}.
                  It creates and updates; it never deletes.
                </Text>
                {plan.missingPermissions.length > 0 && (
                  <MessageStrip tone="warning" title="You cannot import this file">It needs permissions you do not hold: {plan.missingPermissions.join(', ')}.</MessageStrip>
                )}
                <Checkbox label="Show unchanged items" checked={showUnchanged} onChange={setShowUnchanged} />
                <Table caption="Changes the import would make" columns={columns} data={shown} getRowId={(c) => `${c.section}:${c.name}`} getRowLabel={(c) => c.name} emptyState="Nothing would change." maxHeight="28rem" />
                <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap' }}>
                  <Button variant="primary" disabled={!pending || plan.missingPermissions.length > 0} loading={applying} onClick={() => setConfirming(true)}>Import {pending} change{pending === 1 ? '' : 's'}</Button>
                  <Button variant="tertiary" onClick={() => { setPlan(null); setDoc(null); }}>Cancel</Button>
                </div>
              </>
            )}
            {result && (
              result.failed
                ? <MessageStrip tone="error" title="The import stopped part-way">{`${SECTION[result.failed.change.section]} ${result.failed.change.name}: ${result.failed.message} Changes listed before it were applied.${result.backup ? ` A backup from just before the import is at ${result.backup}.` : ''}`}</MessageStrip>
                : <MessageStrip tone="success" title="Configuration imported">{result.backup ? `A backup from just before the import is at ${result.backup}.` : 'Every change is in the audit log.'}</MessageStrip>
            )}
            {result && followUps.length > 0 && (
              <MessageStrip tone="information" title="Still to do">
                <ul style={{ margin: 0, paddingInlineStart: '1.25rem' }}>{followUps.map((c) => <li key={`${c.section}:${c.name}`}><span className="claw-mono">{c.name}</span>: {c.note}</li>)}</ul>
              </MessageStrip>
            )}
          </>
        )}
      </div>
      <AlertDialog open={confirming} tone="warning" title="Import this configuration?" confirmLabel="Import" onCancel={() => setConfirming(false)} onConfirm={() => void apply()}>
        {`${pending} change${pending === 1 ? '' : 's'} will be made on this server${doc ? ` from ${doc.name}` : ''}. A backup is taken first, and every change is audited.`}
      </AlertDialog>
    </Card>
  );
}
