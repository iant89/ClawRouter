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

import { useEffect, useState } from 'react';
import { Button, Dialog, Form, IconButton, Input, MessageStrip, NumberInput, Select, Text, WithFieldHelp } from '@enterprise-ui/react';
import { COST_LIMIT_MAX, type CostLimit, type CostLimits, type FieldIssue, type ModelInfo } from '@clawrouter/shared';

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'start' } as const;
const group = { border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' } as const;
const box = { display: 'grid', gap: 'var(--eui-space-3, 0.75rem)', padding: 'var(--eui-space-3, 0.75rem)', border: '1px solid var(--eui-color-border)', borderRadius: 'var(--eui-radius-md, 6px)' } as const;
const row = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'end' } as const;

const PERIODS = [['hour', 'per hour'], ['day', 'per day'], ['month', 'per month']] as const;
const empty = (c: CostLimit) => c.hour === null && c.day === null && c.month === null;

/** Hourly, daily and monthly amounts in US dollars (empty = no limit). */
function CostFields({ value, onChange, prefix, issue, path }: {
  value: CostLimit; onChange: (v: CostLimit) => void; prefix: string; issue: (p: string) => string | undefined; path: string;
}) {
  return (
    <div style={grid}>
      {PERIODS.map(([p, words]) => (
        <NumberInput key={p} label={`${prefix}$ ${words}`} placeholder="No limit" description="US dollars; empty = no limit" unit="USD"
          min={0.01} max={COST_LIMIT_MAX} step={1} precision={2} value={value[p]} error={issue(`${path}.${p}`)}
          onChange={(n) => onChange({ ...value, [p]: n })} />
      ))}
    </div>
  );
}

/**
 * Edits the cost limits (SEC-005): spending per key, user, gateway, model and
 * provider per UTC hour, day and month, and the estimated cost per request. The
 * server validates everything again on save.
 */
export function CostLimitsDialog({ open, value, models, onClose, onSave, saving, serverIssues, serverError }: {
  open: boolean;
  value: CostLimits | null;
  models: ModelInfo[];
  onClose: () => void;
  onSave: (limits: CostLimits) => void;
  saving: boolean;
  serverIssues: FieldIssue[];
  serverError: string | null;
}) {
  const [draft, setDraft] = useState<CostLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open && value) {
      setDraft(structuredClone(value));
      setError(null);
    }
  }, [open, value]);
  if (!draft) return null;

  const issue = (path: string) => serverIssues.find((i) => i.path === `costLimits.${path}`)?.message;
  const set = <K extends keyof CostLimits>(k: K, v: CostLimits[K]) => setDraft({ ...draft, [k]: v });
  const unusedModels = models.filter((m) => !draft.perModel.some((x) => x.model.toLowerCase() === m.ref.toLowerCase()));
  const providers = [...new Set(models.map((m) => m.provider.identifier))];

  const submit = () => {
    if (draft.perModel.some((m) => !m.model) || draft.perProvider.some((p) => !p.provider.trim())) return setError('Choose a model or provider for every row, or remove the empty row.');
    if ([...draft.perModel, ...draft.perProvider].some(empty)) return setError('Every model and provider cost limit needs an hourly, daily or monthly amount.');
    setError(null);
    onSave(draft);
  };

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Edit cost limits"
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={submit}>Save</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <Form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        {(error ?? serverError) && <MessageStrip tone="error" announce="assertive">{error ?? serverError}</MessageStrip>}
        <Text size="sm" tone="secondary">
          Spending is counted per calendar hour, day and month in UTC, from the provider's reported cost or the model's prices.
          Unpriced models cost nothing here. Leave a field empty for no limit.
        </Text>

        <fieldset style={group}>
          <legend><Text as="strong">Per API key</Text></legend>
          <Text size="sm" tone="secondary">Every key on its own. A key over its limit gets 429 until the period resets.</Text>
          <CostFields prefix="Per key: " value={draft.perKey} onChange={(v) => set('perKey', v)} issue={issue} path="perKey" />
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Per user</Text></legend>
          <Text size="sm" tone="secondary">All keys of the same user, combined.</Text>
          <CostFields prefix="Per user: " value={draft.perUser} onChange={(v) => set('perUser', v)} issue={issue} path="perUser" />
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Whole gateway</Text></legend>
          <CostFields prefix="Gateway: " value={draft.global} onChange={(v) => set('global', v)} issue={issue} path="global" />
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Per request</Text></legend>
          <div style={grid}>
            <WithFieldHelp label="Largest estimated cost per request"
              help="Estimated before a model is tried: the prompt (about four characters per token) at the model's input price plus max_tokens, or the model's maximum output, at its output price. A model on which the request could cost more is not used; if no model is left the request gets 400.">
              <NumberInput label="Largest estimated cost per request" placeholder="No limit" description="US dollars; empty = no limit" unit="USD"
                min={0.01} max={COST_LIMIT_MAX} step={0.1} precision={4} value={draft.maxEstimatedCostPerRequest} error={issue('maxEstimatedCostPerRequest')}
                onChange={(n) => set('maxEstimatedCostPerRequest', n)} />
            </WithFieldHelp>
          </div>
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Per model</Text></legend>
          <Text size="sm" tone="secondary">A model over its budget is skipped and the next model in the route is tried.</Text>
          {draft.perModel.map((m, i) => (
            <div key={i} style={box}>
              <div style={row}>
                <Select label={`Model ${i + 1}`} value={m.model || null} placeholder="Choose a model" error={issue(`perModel[${i}].model`)}
                  onChange={(v) => v && set('perModel', draft.perModel.map((x, j) => (j === i ? { ...x, model: v } : x)))}
                  options={[
                    ...(m.model && !models.some((x) => x.ref.toLowerCase() === m.model.toLowerCase()) ? [{ value: m.model, label: `${m.model} (not registered)` }] : []),
                    ...models.filter((x) => x.ref === m.model || unusedModels.includes(x)).map((x) => ({ value: x.ref, label: x.ref, description: x.displayName })),
                  ]} />
                <IconButton icon="delete" label={`Remove model cost limit ${i + 1}`} onClick={() => set('perModel', draft.perModel.filter((_, j) => j !== i))} />
              </div>
              <CostFields prefix={`Model ${i + 1}: `} value={m} issue={issue} path={`perModel[${i}]`}
                onChange={(v) => set('perModel', draft.perModel.map((x, j) => (j === i ? { ...x, ...v } : x)))} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="tertiary" icon="add" disabled={!unusedModels.length}
              onClick={() => set('perModel', [...draft.perModel, { model: '', hour: null, day: 10, month: null }])}>Add model cost limit</Button>
          </div>
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Per provider</Text></legend>
          <Text size="sm" tone="secondary">All models of a provider together. A provider over its budget is skipped.</Text>
          {draft.perProvider.map((p, i) => (
            <div key={i} style={box}>
              <div style={row}>
                {providers.length ? (
                  <Select label={`Provider ${i + 1}`} value={p.provider || null} placeholder="Choose a provider" error={issue(`perProvider[${i}].provider`)}
                    onChange={(v) => v && set('perProvider', draft.perProvider.map((x, j) => (j === i ? { ...x, provider: v } : x)))}
                    options={[...new Set([...(p.provider ? [p.provider] : []), ...providers])].map((id) => ({ value: id, label: id }))} />
                ) : (
                  <Input label={`Provider ${i + 1}`} description="The provider identifier, e.g. openai" value={p.provider} error={issue(`perProvider[${i}].provider`)}
                    onChange={(e) => set('perProvider', draft.perProvider.map((x, j) => (j === i ? { ...x, provider: e.target.value } : x)))} />
                )}
                <IconButton icon="delete" label={`Remove provider cost limit ${i + 1}`} onClick={() => set('perProvider', draft.perProvider.filter((_, j) => j !== i))} />
              </div>
              <CostFields prefix={`Provider ${i + 1}: `} value={p} issue={issue} path={`perProvider[${i}]`}
                onChange={(v) => set('perProvider', draft.perProvider.map((x, j) => (j === i ? { ...x, ...v } : x)))} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="tertiary" icon="add" onClick={() => set('perProvider', [...draft.perProvider, { provider: '', hour: null, day: null, month: 100 }])}>Add provider cost limit</Button>
          </div>
        </fieldset>
      </Form>
    </Dialog>
  );
}
