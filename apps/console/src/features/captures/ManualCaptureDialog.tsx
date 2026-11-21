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
import { Button, Dialog, MessageStrip, MultiSelect, NumberInput, Select, useToast, WithFieldHelp, type SelectOption } from '@enterprise-ui/react';
import { MANUAL_CAPTURE_MAX_COUNT, MANUAL_CAPTURE_MAX_MINUTES, type ModelInfo, type ProviderInfo } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { startManualCapture } from '../../services/captures.ts';
import { fetchAllModels } from '../../services/models.ts';
import { fetchProviders } from '../../services/providers.ts';
import { ALL_MODELS, modelsToSend, nextModelChoice } from './model-choice.ts';

/**
 * Starts a manual capture: the next N requests that match are kept even when they
 * succeed, for replies that look wrong without an error (a provider field read
 * wrongly, text cut off, a tool call lost). One at a time; it ends after N
 * requests or the time limit.
 */
export function ManualCaptureDialog({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providerId, setProviderId] = useState('any');
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelChoice, setModelChoice] = useState<string[]>([ALL_MODELS]);
  const [count, setCount] = useState<number | null>(5);
  const [minutes, setMinutes] = useState<number | null>(60);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setIssues({});
    const controller = new AbortController();
    // Without providers.read the list is unavailable: the capture then covers every provider.
    fetchProviders(controller.signal).then(setProviders).catch(() => setProviders([]));
    return () => controller.abort();
  }, [open]);

  // The models offered: the chosen provider's, or every provider's grouped by provider. Without
  // models.read the list is empty and only "All models" can be chosen.
  useEffect(() => {
    if (!open) return;
    setModels(null);
    setModelChoice([ALL_MODELS]);
    const controller = new AbortController();
    fetchAllModels(providerId === 'any' ? {} : { providerId }, controller.signal).then(setModels).catch(() => { if (!controller.signal.aborted) setModels([]); });
    return () => controller.abort();
  }, [open, providerId]);

  const modelOptions = useMemo<SelectOption[]>(() => [
    { value: ALL_MODELS, label: 'All models' },
    ...(models ?? []).map((m) => ({ value: m.ref, label: m.displayName, description: m.ref, group: providerId === 'any' ? m.provider.name : undefined })),
  ], [models, providerId]);

  const start = async () => {
    setSaving(true);
    setError(null);
    try {
      await startManualCapture({ providerId: providerId === 'any' ? null : providerId, models: modelsToSend(modelChoice), count: count ?? 0, minutes: minutes ?? 0 });
      toast.show({ tone: 'success', title: 'Manual capture started', description: `The next ${count} matching request${count === 1 ? '' : 's'} will be captured.` });
      onStarted();
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) setIssues(Object.fromEntries(err.issues.map((i) => [i.path, i.message])));
      setError(err instanceof Error ? err.message : 'Could not start the capture.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open} onClose={onClose} title="Capture the next requests" size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="record" onClick={() => void start()} loading={saving}>Start capturing</Button>
      </>}
    >
      <MessageStrip tone="information">
        Errors are captured on their own. Use this when replies look wrong but nothing fails: matching requests are kept even when they succeed.
      </MessageStrip>
      {error && <MessageStrip tone="error">{error}</MessageStrip>}
      <WithFieldHelp label="Provider" help="Only requests that tried this provider are captured. Any: every provider.">
        <Select label="Provider" value={providerId} onChange={(v) => setProviderId(v ?? 'any')}
          options={[{ value: 'any', label: 'Any provider' }, ...(providers ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
      </WithFieldHelp>
      <WithFieldHelp label="Models" help="Only requests for the checked models are captured, whether the client asked for the model or ClawRouter routed to it (an alias reaches the models it routes to). All models: every model, including ones added later.">
        <MultiSelect label="Models" value={modelChoice} onChange={(next) => setModelChoice((previous) => nextModelChoice(previous, next))}
          options={modelOptions} disabled={models === null} placeholder={models === null ? 'Loading models…' : undefined}
          emptyText="No models match" error={issues.models} maxVisibleTokens={4}
          description={models !== null && !models.length ? (providerId === 'any' ? 'No models to choose from: every model is captured.' : 'This provider has no models: every request to it is captured.') : undefined} />
      </WithFieldHelp>
      <NumberInput label="Requests to capture" min={1} max={MANUAL_CAPTURE_MAX_COUNT} step={1} value={count} onChange={setCount} error={issues.count}
        description={`1–${MANUAL_CAPTURE_MAX_COUNT}`} />
      <NumberInput label="Stop after" unit="minutes" min={1} max={MANUAL_CAPTURE_MAX_MINUTES} step={5} value={minutes} onChange={setMinutes} error={issues.minutes}
        description={`1–${MANUAL_CAPTURE_MAX_MINUTES}. The capture ends after that many requests or this long, whichever comes first.`} />
    </Dialog>
  );
}
