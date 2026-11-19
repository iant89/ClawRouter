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
import { Button, Dialog, Form, IconButton, MessageStrip, NumberInput, Select, Text, WithFieldHelp } from '@enterprise-ui/react';
import type { FieldIssue, ModelInfo, ModelRateLimit, RateLimitSettings } from '@clawrouter/shared';
import { LimitFields, limitErrors } from './LimitFields.tsx';

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)' } as const;
const group = { border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' } as const;
const modelBox = { display: 'grid', gap: 'var(--eui-space-3, 0.75rem)', padding: 'var(--eui-space-3, 0.75rem)', border: '1px solid var(--eui-color-border)', borderRadius: 'var(--eui-radius-md, 6px)' } as const;

/** Edits the whole rate-limit configuration; the server validates it again on save. */
export function RateLimitsDialog({ open, value, models, onClose, onSave, saving, serverIssues, serverError }: {
  open: boolean;
  value: RateLimitSettings | null;
  models: ModelInfo[];
  onClose: () => void;
  onSave: (settings: RateLimitSettings) => void;
  saving: boolean;
  serverIssues: FieldIssue[];
  serverError: string | null;
}) {
  const [draft, setDraft] = useState<RateLimitSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open && value) {
      setDraft(structuredClone(value));
      setError(null);
    }
  }, [open, value]);
  if (!draft) return null;

  const issue = (path: string) => serverIssues.find((i) => i.path === path)?.message;
  const set = <K extends keyof RateLimitSettings>(k: K, v: RateLimitSettings[K]) => setDraft({ ...draft, [k]: v });
  const setModel = (i: number, patch: Partial<ModelRateLimit>) => set('perModel', draft.perModel.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const unused = models.filter((m) => !draft.perModel.some((x) => x.model.toLowerCase() === m.ref.toLowerCase()));

  const submit = () => {
    if (draft.perModel.some((m) => !m.model)) return setError('Choose a model for every model limit, or remove the empty row.');
    if (draft.perModel.some((m) => m.requests === null && m.tokens === null && m.bucket === null)) return setError('Every model limit needs requests, tokens or a burst bucket.');
    setError(null);
    onSave(draft);
  };

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Edit rate limits"
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={submit}>Save</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <Form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        {(error ?? serverError) && <MessageStrip tone="error" announce="assertive">{error ?? serverError}</MessageStrip>}
        <Text size="sm" tone="secondary">Each limit counts requests and tokens over a sliding second, minute or hour, and can also limit bursts. Leave a field empty for no limit.</Text>

        <fieldset style={group}>
          <legend><Text as="strong">Per API key</Text></legend>
          <Text size="sm" tone="secondary">Default for every key without its own limit (set on the API Access page).</Text>
          <LimitFields labelPrefix="Per key: " value={draft.perKey} onChange={(v) => set('perKey', v)} errors={limitErrors(issue, 'perKey')} />
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Per user</Text></legend>
          <Text size="sm" tone="secondary">All keys created by the same user, combined.</Text>
          <LimitFields labelPrefix="Per user: " value={draft.perUser} onChange={(v) => set('perUser', v)} errors={limitErrors(issue, 'perUser')} />
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Whole gateway</Text></legend>
          <LimitFields labelPrefix="Gateway: " value={draft.global} onChange={(v) => set('global', { ...draft.global, ...v })} errors={limitErrors(issue, 'global')} />
          <div style={grid}>
            <NumberInput label="Gateway: requests at the same time" placeholder="No limit" min={1} step={1} value={draft.global.maxConcurrent}
              onChange={(n) => set('global', { ...draft.global, maxConcurrent: n })} error={issue('global.maxConcurrent')} />
          </div>
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Per model</Text></legend>
          <Text size="sm" tone="secondary">Keeps a model inside its provider's quota. A model at its limit is skipped and the next model in the route is tried.</Text>
          {draft.perModel.map((m, i) => (
            <div key={i} style={modelBox}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'end' }}>
              <Select
                label={`Model ${i + 1}`}
                value={m.model || null}
                placeholder="Choose a model"
                onChange={(v) => v && setModel(i, { model: v })}
                error={issue(`perModel[${i}].model`)}
                options={[
                  ...(m.model && !models.some((x) => x.ref.toLowerCase() === m.model.toLowerCase()) ? [{ value: m.model, label: `${m.model} (not registered)` }] : []),
                  ...models.filter((x) => x.ref === m.model || unused.includes(x)).map((x) => ({ value: x.ref, label: x.ref, description: x.displayName })),
                ]}
              />
              <IconButton icon="delete" label={`Remove model limit ${i + 1}`} onClick={() => set('perModel', draft.perModel.filter((_, j) => j !== i))} />
              </div>
              <LimitFields value={m} onChange={(v) => setModel(i, v)} errors={limitErrors(issue, `perModel[${i}]`)} labelPrefix={`Model ${i + 1}: `} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="tertiary" icon="add" disabled={!unused.length}
              onClick={() => set('perModel', [...draft.perModel, { model: '', window: 'minute', requests: 60, tokens: null, bucket: null }])}>
              Add model limit
            </Button>
          </div>
        </fieldset>

        <fieldset style={group}>
          <legend><Text as="strong">Invalid API keys</Text></legend>
          <div style={grid}>
            <WithFieldHelp label="Failed key checks per address per minute" help="Requests with a missing or wrong API key, counted per client address. Past the limit, every request from that address gets 429 until the minute has passed, even with a valid key.">
              <NumberInput label="Failed key checks per address per minute"
                min={1} max={10_000} step={1} value={draft.invalidKeysPerIp} onChange={(n) => set('invalidKeysPerIp', n ?? 1)} error={issue('invalidKeysPerIp')} />
            </WithFieldHelp>
          </div>
        </fieldset>
      </Form>
    </Dialog>
  );
}
