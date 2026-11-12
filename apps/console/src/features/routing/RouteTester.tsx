import { useState } from 'react';
import { Button, Card, DescriptionList, Form, Input, MessageStrip, MultiSelect, StatusIndicator, Table, Text, type TableColumn } from '@enterprise-ui/react';
import { CAPABILITIES, type Capability, type RouteAttempt, type RoutePlan } from '@clawrouter/shared';
import { ProviderStatus } from '../../components/custom/ProviderStatus.tsx';
import { ApiClientError } from '../../services/api-client.ts';
import { previewRoute } from '../../services/routing.ts';
import { CAPABILITY_LABEL } from '../models/ModelDialog.tsx';
import { describePolicy } from './routing-utils.ts';

const RESOLUTION: Record<RoutePlan['resolvedAs'], string> = {
  alias: 'Alias',
  model_ref: 'Exact model reference',
  model_id: 'Provider model id (every provider offering it)',
};

/**
 * Dry run of the routing engine: shows which models a request would try, in
 * order, and why others are left out. Nothing is sent to a provider.
 */
export function RouteTester({ initialModel = '' }: { initialModel?: string }) {
  const [model, setModel] = useState(initialModel);
  const [caps, setCaps] = useState<Capability[]>([]);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [error, setError] = useState<{ message: string; excluded: { modelRef: string; reason: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!model.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setPlan(await previewRoute(model.trim(), caps));
    } catch (err) {
      setPlan(null);
      const raw = err instanceof ApiClientError ? err.details.excluded : undefined;
      const excluded = Array.isArray(raw) ? (raw as { modelRef: string; reason: string }[]) : [];
      setError({ message: err instanceof Error ? err.message : 'Preview failed.', excluded });
    } finally {
      setBusy(false);
    }
  };

  const attemptColumns: TableColumn<RouteAttempt & { n: number }>[] = [
    { id: 'n', header: '#', align: 'end', accessor: 'n', width: '3rem', cell: (a) => <span className="claw-mono">{a.n}</span> },
    {
      id: 'model', header: 'Model', rowHeader: true, wrap: true, accessor: (a) => plan!.candidates[a.candidate]!.modelRef,
      cell: (a) => <span className="claw-mono claw-break">{plan!.candidates[a.candidate]!.modelRef}</span>,
    },
    { id: 'try', header: 'Try', accessor: 'try', cell: (a) => (a.try === 1 ? 'First try' : `Retry ${a.try - 1}`) },
    {
      id: 'provider', header: 'Provider', wrap: true, accessor: (a) => plan!.candidates[a.candidate]!.providerName,
      cell: (a) => {
        const c = plan!.candidates[a.candidate]!;
        return <span>{c.providerName} <ProviderStatus state={c.providerStatus} size="sm" />{c.recentFailures ? <> <StatusIndicator tone="warning" size="sm">{`${c.recentFailures} recent failures`}</StatusIndicator></> : null}</span>;
      },
    },
    { id: 'pw', header: 'Priority · weight', align: 'end', accessor: (a) => plan!.candidates[a.candidate]!.priority, cell: (a) => <span className="claw-mono">{plan!.candidates[a.candidate]!.priority} · {plan!.candidates[a.candidate]!.weight}</span> },
  ];

  return (
    <Card title="Route tester" subtitle="See how a model name would be routed. Nothing is sent to a provider." headingLevel={2}>
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        <Form onSubmit={(e) => { e.preventDefault(); void run(); }} noValidate>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr)) auto', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'end' }}>
            <Input label="Model" className="claw-mono" placeholder="fast-code, openai/gpt-4o or gpt-4o-mini" value={model} onChange={(e) => setModel(e.target.value)} />
            <MultiSelect label="Required capabilities" placeholder="None" value={caps} onChange={(v) => setCaps(v as Capability[])} options={CAPABILITIES.map((c) => ({ value: c, label: CAPABILITY_LABEL[c] }))} />
            <Button type="submit" variant="primary" loading={busy} disabled={!model.trim()}>Preview route</Button>
          </div>
        </Form>
        {error && (
          <MessageStrip tone="error" title="Not routable">
            {error.message}
            {error.excluded.length > 0 && (
              <ul style={{ margin: 'var(--eui-space-1, 0.25rem) 0 0', paddingInlineStart: '1.25rem' }}>
                {error.excluded.map((x) => <li key={x.modelRef}><span className="claw-mono">{x.modelRef}</span>: {x.reason}</li>)}
              </ul>
            )}
          </MessageStrip>
        )}
        {plan && (
          <>
            <DescriptionList
              columns={3}
              items={[
                { term: 'Resolved as', description: plan.alias ? `${RESOLUTION.alias} "${plan.alias}"` : RESOLUTION[plan.resolvedAs] },
                { term: 'Policy', description: describePolicy(plan.policy) },
                { term: 'Required capabilities', description: plan.requiredCapabilities.length ? plan.requiredCapabilities.map((c) => CAPABILITY_LABEL[c]).join(', ') : 'None' },
              ]}
            />
            <Table caption="Attempts, in order" columns={attemptColumns} data={plan.attempts.map((a, i) => ({ ...a, n: i + 1 }))} getRowId={(a) => String(a.n)} />
            {plan.excluded.length > 0 && (
              <div>
                <Text as="strong" size="sm">Left out</Text>
                <ul style={{ margin: 'var(--eui-space-1, 0.25rem) 0 0', paddingInlineStart: '1.25rem' }}>
                  {plan.excluded.map((x) => <li key={x.modelRef}><span className="claw-mono">{x.modelRef}</span>: {x.reason}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
