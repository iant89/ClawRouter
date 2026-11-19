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

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertDialog, Button, MessageStrip, Select, Text, Wizard, type WizardStep } from '@enterprise-ui/react';
import { SETUP_WIZARD_STEPS, type CreateApiKeyRequest, type CreatedApiKey, type ModelInfo, type Permission, type ProviderInfo, type ProviderKindInfo, type SetupWizardStep } from '@clawrouter/shared';
import { AuthPanel } from '../../components/custom/AuthPanel.tsx';
import { ProviderStatus } from '../../components/custom/ProviderStatus.tsx';
import { fetchProviderKinds, fetchProviders, testProvider } from '../../services/providers.ts';
import { fetchModels } from '../../services/models.ts';
import { createApiKey } from '../../services/gateway.ts';
import { createMyKey } from '../../services/key-requests.ts';
import { sendTestRequest, updateSetupWizard, type TestRequestResult } from '../../services/onboarding.ts';
import { useAuth, usePermissions, useSession } from '../auth/AuthContext.tsx';
import { ProviderDialog } from '../providers/ProviderDialog.tsx';
import { DiscoverDialog } from '../models/DiscoverDialog.tsx';
import { CreateKeyDialog } from '../api-access/CreateKeyDialog.tsx';
import { useModelOptions } from '../api-access/model-options.ts';
import { describeKeyError } from '../api-access/key-issues.ts';
import { MailServerCard, TwoFactorPolicyCard } from '../settings/SignInSecuritySettings.tsx';

const stack = { display: 'grid', gap: 'var(--eui-space-3, 0.75rem)', justifyItems: 'start' } as const;
const list = { margin: 0, paddingInlineStart: '1.25rem', display: 'grid', gap: 'var(--eui-space-1, 0.25rem)' } as const;

/** Shown in a step the signed-in user's role cannot do: they can skip it. */
function NotAllowed({ what }: { what: string }) {
  return <MessageStrip tone="information">Your role cannot {what}. Skip this step; someone who can will do it later.</MessageStrip>;
}

/**
 * The first-run setup wizard (owner request, 2026-11-16): after the first
 * administrator is created, it walks through getting a first request through
 * the gateway (provider, models, API key, a real test request) and sign-in
 * security (mail server, two-factor policy). Every step can be skipped with
 * Next, and the whole wizard with Cancel. Progress is saved on the server, so
 * it resumes where it was left. Each step uses the console's ordinary dialogs
 * and APIs, which check their own permissions.
 */
export function SetupWizard() {
  const { refresh } = useAuth();
  const session = useSession();
  const perms = usePermissions();
  const can = (p: Permission) => perms.can(p);
  const saved = session.onboarding.setupWizard;
  const [index, setIndex] = useState(() => Math.max(0, saved?.step ? SETUP_WIZARD_STEPS.indexOf(saved.step) : 0));

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [kinds, setKinds] = useState<ProviderKindInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const [p, k, m] = await Promise.all([
        can('providers.read') ? fetchProviders() : Promise.resolve([]),
        can('providers.read') ? fetchProviderKinds() : Promise.resolve([]),
        can('models.read') ? fetchModels({ page: 1, pageSize: 200, capability: 'CHAT' }).then((r) => r.items) : Promise.resolve([]),
      ]);
      setProviders(p);
      setKinds(k);
      setModels(m);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the current setup.');
    }
  }, [perms.set]);
  useEffect(() => { void reload(); }, [reload]);

  // Step 1: provider.
  const [addingProvider, setAddingProvider] = useState(false);
  const [test, setTest] = useState<{ name: string; ok: boolean; message: string } | null>(null);
  // Step 2: models.
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  // Step 3: API key. The secret stays in memory for the test request only.
  const [keyDialog, setKeyDialog] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const modelOptions = useModelOptions(keyDialog);
  // Step 4: test request.
  const [testModel, setTestModel] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestRequestResult | null>(null);
  // Step 5 and 6: mail and sign-in security.
  const [mailConfigured, setMailConfigured] = useState<boolean>();
  // Leaving.
  const [leaving, setLeaving] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  const usable = models.filter((m) => m.enabled);
  const chosenModel = testModel ?? usable[0]?.ref ?? null;

  const createKey = async (body: CreateApiKeyRequest) => {
    setKeySaving(true);
    try {
      // Administrators create through API Access; others with api_keys.own create their own key.
      setCreated(await (can('api_keys.write') ? createApiKey(body) : createMyKey({ name: body.name, allowedModels: body.allowedModels, expiry: body.expiry })));
      setKeyError(null);
    } catch (err) {
      setKeyError(describeKeyError(err, 'Could not create the key.'));
    } finally {
      setKeySaving(false);
    }
  };

  const send = async () => {
    if (!created || !chosenModel) return;
    setSending(true);
    try {
      setResult(await sendTestRequest(created.secret, chosenModel));
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : 'The request failed.', model: null, inputTokens: null, outputTokens: null, latencyMs: 0, requestId: null });
    } finally {
      setSending(false);
    }
  };

  const end = async (status: 'COMPLETED' | 'DISMISSED') => {
    try {
      await updateSetupWizard({ status });
      await refresh();
    } catch (err) {
      setEndError(err instanceof Error ? err.message : 'Could not save. Try again.');
      throw err;
    }
  };

  const content: Record<SetupWizardStep, { title: string; description: ReactNode; body: ReactNode }> = {
    provider: {
      title: 'Connect a provider',
      description: 'A provider is where requests go: OpenAI, Anthropic, Google, Groq, or a local OpenAI-compatible server. Its API key is encrypted and never shown again.',
      body: !can('providers.write') ? <NotAllowed what="add providers" /> : (
        <div style={stack}>
          {providers.length > 0 && (
            <ul style={list} aria-label="Providers">
              {providers.map((p) => <li key={p.id}><Text as="strong">{p.name}</Text> <ProviderStatus state={p.status} size="sm" /></li>)}
            </ul>
          )}
          <Button variant={providers.length ? 'secondary' : 'primary'} icon="add" onClick={() => setAddingProvider(true)}>{providers.length ? 'Add another provider' : 'Add a provider'}</Button>
          {test && <MessageStrip tone={test.ok ? 'success' : 'error'} title={test.ok ? `${test.name}: connected` : `${test.name}: connection failed`}>{test.message}</MessageStrip>}
        </div>
      ),
    },
    models: {
      title: 'Import models',
      description: 'ClawRouter asks each provider which models it offers; pick the ones to use. Prices are filled in automatically where the provider publishes them.',
      body: !can('models.write') ? <NotAllowed what="import models" /> : providers.length === 0 ? (
        <MessageStrip tone="information">Connect a provider first (step 1), or skip this step.</MessageStrip>
      ) : (
        <div style={stack}>
          {models.length > 0 && <Text>{models.length} chat model{models.length === 1 ? '' : 's'} ready: <span className="claw-mono">{models.slice(0, 4).map((m) => m.ref).join(', ')}{models.length > 4 ? ', …' : ''}</span></Text>}
          <Button variant={models.length ? 'secondary' : 'primary'} icon="download" onClick={() => setImporting(true)}>{models.length ? 'Import more models' : 'Import models'}</Button>
          {imported && <MessageStrip tone="success">{imported}</MessageStrip>}
        </div>
      ),
    },
    api_key: {
      title: 'Create an API key',
      description: 'Applications send this key to ClawRouter instead of a provider key. It is shown once; ClawRouter keeps only a hash.',
      body: !can('api_keys.write') && !can('api_keys.own') ? <NotAllowed what="create API keys" /> : (
        <div style={stack}>
          {created ? (
            <MessageStrip tone="success" title={`Key "${created.key.name}" created`}>
              <span className="claw-mono">{created.key.prefix}…</span>. Keep the copy you made; the next step uses this key once for a test request.
            </MessageStrip>
          ) : (
            <Button variant="primary" icon="key" onClick={() => setKeyDialog(true)}>Create an API key</Button>
          )}
        </div>
      ),
    },
    test_request: {
      title: 'Send a test request',
      description: 'A real request through the gateway, sent with your new key exactly as an application would. It appears in Requests and Usage like any other.',
      body: !created ? (
        <MessageStrip tone="information">Create an API key first (step 3), or skip this step.</MessageStrip>
      ) : usable.length === 0 ? (
        <MessageStrip tone="information">Import a chat model first (step 2), or skip this step.</MessageStrip>
      ) : (
        <div style={stack}>
          <Select label="Model" value={chosenModel ?? undefined} onChange={(v) => v && setTestModel(v)} options={usable.map((m) => ({ value: m.ref, label: m.ref, description: m.displayName }))} />
          <Button variant="primary" icon="paper-plane" loading={sending} onClick={send}>Send a test request</Button>
          {result && (result.ok ? (
            <MessageStrip tone="success" title={`${result.model} answered in ${result.latencyMs} ms`}>
              <span style={{ display: 'block', fontStyle: 'italic' }}>“{result.text}”</span>
              {result.inputTokens !== null && <Text size="sm" tone="secondary">{result.inputTokens} tokens in, {result.outputTokens} out{result.requestId ? ` · request ${result.requestId}` : ''}</Text>}
            </MessageStrip>
          ) : (
            <MessageStrip tone="error" title="The request failed">{result.text}{result.requestId ? ` (request ${result.requestId}: see Requests for each attempt)` : ''}</MessageStrip>
          ))}
        </div>
      ),
    },
    mail: {
      title: 'Mail server',
      description: 'Needed only for sign-in codes sent by email. Skip it if everyone will use an authenticator app, or if you do not want two-factor sign-in yet.',
      body: <MailServerCard canWrite={can('settings.write')} onLoaded={(s) => setMailConfigured(s.configured)} />,
    },
    sign_in: {
      title: 'Sign-in security',
      description: 'Choose who must use two-factor sign-in, and with which methods. Users set it up themselves at their next sign-in.',
      body: <TwoFactorPolicyCard canWrite={can('settings.write')} mailConfigured={mailConfigured} />,
    },
  };

  const steps: WizardStep[] = SETUP_WIZARD_STEPS.map((id) => ({
    // Every step can be skipped with Next (the intro says so); marking each one Optional only adds noise.
    id, title: content[id].title, description: content[id].description,
    content: <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>{loadError && <MessageStrip tone="error">{loadError}</MessageStrip>}{content[id].body}</div>,
  }));

  return (
    <AuthPanel
      wide="xl"
      title="Set up ClawRouter"
      subtitle="A few steps to a first request through the gateway, then sign-in security. Skip any step, or the whole setup: it can be run again from the help menu."
    >
      {endError && <MessageStrip tone="error" announce="assertive">{endError}</MessageStrip>}
      <Wizard
        aria-label="Set up ClawRouter"
        steps={steps}
        step={index}
        onStepChange={(i) => {
          setIndex(i);
          void updateSetupWizard({ status: 'PENDING', step: SETUP_WIZARD_STEPS[i] }).catch(() => {});
        }}
        onFinish={() => end('COMPLETED')}
        onCancel={() => setLeaving(true)}
        finishLabel="Finish setup"
      />

      <ProviderDialog
        open={addingProvider}
        provider={null}
        kinds={kinds}
        onClose={() => setAddingProvider(false)}
        onSaved={(saved) => {
          setAddingProvider(false);
          void reload();
          // Check the new provider right away, so the next steps can rely on it.
          void testProvider(saved.id)
            .then((r) => setTest({ name: saved.name, ok: r.ok, message: r.ok && r.modelCount !== null ? `${r.message} ${r.modelCount} models available.` : r.message }))
            .catch((err: unknown) => setTest({ name: saved.name, ok: false, message: err instanceof Error ? err.message : 'The test failed.' }))
            .finally(() => void reload());
        }}
      />
      <DiscoverDialog
        open={importing}
        providers={providers}
        initialProviderId={providers[0]?.id}
        onClose={() => setImporting(false)}
        onImported={(count, name) => {
          setImporting(false);
          setImported(`${count} model${count === 1 ? '' : 's'} imported from ${name}.`);
          void reload();
        }}
      />
      <CreateKeyDialog
        open={keyDialog}
        modelOptions={modelOptions}
        withLimits={false}
        onClose={() => setKeyDialog(false)}
        onCreate={createKey}
        created={created}
        saving={keySaving}
        serverError={keyError}
      />
      <AlertDialog
        open={leaving}
        tone="warning"
        title="Leave the setup?"
        confirmLabel="Leave setup"
        onCancel={() => setLeaving(false)}
        onConfirm={() => { setLeaving(false); void end('DISMISSED').catch(() => {}); }}
      >
        What you have done so far is kept. You can run the setup again at any time from the help menu.
      </AlertDialog>
    </AuthPanel>
  );
}
