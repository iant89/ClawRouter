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

import { useEffect, useRef, useState } from 'react';
import {
  Button, Card, CopyButton, Dialog, Link, MessageStrip, NumberInput, Page, PromptInput, Select, StatusIndicator, Switch, Text, TextArea, WithFieldHelp,
} from '@enterprise-ui/react';
import type { ApiKeyInfo } from '@clawrouter/shared';
import { ApiClientError } from '../../services/api-client.ts';
import { fetchMyKeys } from '../../services/key-requests.ts';
import { fetchPlaygroundModels, sendPlaygroundChat, type PlaygroundAnswer, type PlaygroundMessage, type PlaygroundModel } from '../../services/playground.ts';
import { formatDuration, formatTokens } from '../../services/format.ts';
import { useRouter } from '../../app/router.tsx';
import { usePermissions } from '../auth/AuthContext.tsx';
import { RequestDetailDialog } from '../requests/RequestDetailDialog.tsx';
import { CHAT_CLIENTS, type ChatClient } from './chat-clients.ts';

interface Turn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** Assistant turns: what the gateway said about the answer (null while it streams). */
  answer?: PlaygroundAnswer | null;
  /** Assistant turns that failed: the error, instead of an answer. */
  error?: { message: string; requestId: string | null };
  stopped?: boolean;
}

const SUGGESTIONS = ['Say hello in one short sentence.', 'Which model are you?', 'Count from 1 to 20, one number per line.'];

/** Remembered in this browser only: which key and model were used last. */
const REMEMBER = 'clawrouter.playground';
function remembered(): { keyId?: string; model?: string } {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER) ?? '{}') as { keyId?: string; model?: string };
  } catch {
    return {};
  }
}
function remember(value: { keyId: string | null; model: string | null }) {
  try {
    localStorage.setItem(REMEMBER, JSON.stringify(value));
  } catch {
    // private window: nothing to remember
  }
}

const describeError = (err: unknown) => (err instanceof ApiClientError
  ? { message: err.retryAfter ? `${err.message} Try again in ${err.retryAfter} s.` : err.message, requestId: err.requestId }
  : { message: err instanceof Error ? err.message : 'The request failed.', requestId: null });

/**
 * Gateway → Playground: chat with a model through the real gateway, as one of
 * your own API keys. Routing, failover, rate limits, quotas, history and usage
 * apply exactly as for an application. The conversation is never stored: it
 * lives in this page and is gone when you leave it.
 */
export function PlaygroundPage() {
  const { navigate } = useRouter();
  const perms = usePermissions();
  const canSeeRequests = perms.can('requests.read');
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [models, setModels] = useState<PlaygroundModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [stream, setStream] = useState(true);
  const [temperature, setTemperature] = useState<number | null>(null);
  const [maxTokens, setMaxTokens] = useState<number | null>(null);
  const [system, setSystem] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const [client, setClient] = useState<ChatClient | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    const controller = new AbortController();
    fetchMyKeys(controller.signal)
      .then((all) => {
        const active = all.filter((k) => k.status === 'ACTIVE');
        setKeys(active);
        const last = remembered().keyId;
        setKeyId(active.find((k) => k.id === last)?.id ?? active[0]?.id ?? null);
      })
      .catch((err: unknown) => { if (!controller.signal.aborted) setKeysError(err instanceof Error ? err.message : 'Could not load your keys.'); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!keyId) return;
    const controller = new AbortController();
    setModels(null);
    setModelsError(null);
    fetchPlaygroundModels(keyId, controller.signal)
      .then((list) => {
        setModels(list);
        setModel((current) => {
          const wanted = current ?? remembered().model;
          return list.find((m) => m.id === wanted)?.id ?? list[0]?.id ?? null;
        });
      })
      .catch((err: unknown) => { if (!controller.signal.aborted) setModelsError(err instanceof Error ? err.message : 'Could not load the models.'); });
    return () => controller.abort();
  }, [keyId]);

  useEffect(() => { remember({ keyId, model }); }, [keyId, model]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [turns]);

  const update = (id: number, patch: Partial<Turn>) => setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const send = async (text: string) => {
    if (!keyId || !model || busy || !text.trim()) return;
    const user: Turn = { id: nextId.current++, role: 'user', content: text };
    const reply: Turn = { id: nextId.current++, role: 'assistant', content: '', answer: null };
    // Failed and stopped answers are not part of the conversation sent back.
    const history: PlaygroundMessage[] = [
      ...(system.trim() ? [{ role: 'system' as const, content: system.trim() }] : []),
      ...turns.filter((t) => t.role === 'user' || (t.answer && !t.error)).map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: text },
    ];
    setTurns((all) => [...all, user, reply]);
    setPrompt('');
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const answer = await sendPlaygroundChat({ keyId, model, stream, temperature, maxTokens }, history, (soFar) => update(reply.id, { content: soFar }), controller.signal);
      update(reply.id, { content: answer.content, answer });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') update(reply.id, { stopped: true, answer: undefined });
      else update(reply.id, { error: describeError(err), answer: undefined });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const clear = () => {
    abortRef.current?.abort();
    setTurns([]);
  };

  const myKeys = (e: React.MouseEvent) => {
    e.preventDefault();
    navigate('/my-keys');
  };
  const baseUrl = `${location.origin}/v1`;
  const noKeys = keys !== null && keys.length === 0;

  return (
    <Page
      title="Playground"
      subtitle="Chat through the gateway with one of your API keys. Nothing is stored: the conversation lives in this page."
      actions={<Button variant="secondary" icon="delete" onClick={clear} disabled={turns.length === 0}>Clear conversation</Button>}
    >
      {keysError && <MessageStrip tone="error" title="Cannot load your keys">{keysError}</MessageStrip>}
      {noKeys && (
        <MessageStrip tone="information" title="You need an API key">
          The playground sends requests as one of your own active keys, so its limits and allowed models apply. Create or request one under{' '}
          <Link href="/my-keys" onClick={myKeys}>My API keys</Link>.
        </MessageStrip>
      )}

      <div className="claw-playground">
        <Card title="Settings" headingLevel={2} className="claw-playground-settings">
          <div className="claw-stack">
            <WithFieldHelp label="API key" help={<>The request is made as this key: its allowed models, rate limits and your quota apply, and it appears under this key in request history and usage. The key's secret is not needed; your sign-in proves the key is yours.</>}>
              <Select label="API key" value={keyId} onChange={setKeyId} disabled={!keys?.length} placeholder={keys === null ? 'Loading…' : 'No active keys'}
                options={(keys ?? []).map((k) => ({ value: k.id, label: k.name, description: `${k.prefix}… · ${k.allowedModels.length ? k.allowedModels.join(', ') : 'any model'}` }))} />
            </WithFieldHelp>
            <WithFieldHelp label="Model" help={<>Aliases and models this key may use, as an application sees them at /v1/models. An alias is routed like any request, with its fallbacks.</>}>
              <Select label="Model" value={model} onChange={setModel} disabled={!models?.length} placeholder={keyId && !models && !modelsError ? 'Loading…' : 'No models'}
                options={(models ?? []).map((m) => ({ value: m.id, label: m.id, description: m.ownedBy === 'clawrouter' ? 'Alias' : undefined }))} />
            </WithFieldHelp>
            {modelsError && <MessageStrip tone="error">{modelsError}</MessageStrip>}
            {models?.length === 0 && <MessageStrip tone="warning">This key cannot use any model right now.</MessageStrip>}
            <TextArea label="System prompt" value={system} onChange={(e) => setSystem(e.target.value)} rows={3} autoResize maxRows={8} maxLength={20_000} placeholder="Optional" />
            <WithFieldHelp label="Stream" help={<>Streamed answers arrive piece by piece, as most chat apps ask for them. Turn it off to see a whole answer at once.</>}>
              <Switch label="Stream the answer" checked={stream} onChange={setStream} />
            </WithFieldHelp>
            <NumberInput label="Temperature" description="0–2. Empty: the model's default." min={0} max={2} step={0.1} value={temperature} onChange={setTemperature} />
            <WithFieldHelp label="Maximum tokens" help={<>The longest answer the model may write, in tokens (about four characters each). An answer that hits it ends with “length”.</>}>
              <NumberInput label="Maximum tokens" description="Empty: the model's default." min={1} max={200_000} step={100} value={maxTokens} onChange={setMaxTokens} />
            </WithFieldHelp>
          </div>
        </Card>

        <Card title="Conversation" headingLevel={2} className="claw-playground-chat">
          <div className="claw-chat" aria-live="polite" aria-busy={busy}>
            {turns.length === 0 && <Text tone="secondary">Send a message to start. Each answer shows the model that answered, its tokens and its timing.</Text>}
            {turns.map((t) => (
              <div key={t.id} className={`claw-chat-turn claw-chat-${t.role}`}>
                <Text size="sm" tone="secondary" as="div">{t.role === 'user' ? 'You' : 'Assistant'}</Text>
                {t.error ? (
                  <MessageStrip tone="error" title="The request failed">
                    {t.error.message}{t.error.requestId && <> <span className="claw-mono">({t.error.requestId})</span></>}
                  </MessageStrip>
                ) : (
                  <div className="claw-chat-text">{t.content || (t.answer === null && !t.stopped ? '…' : '')}</div>
                )}
                {t.stopped && <Text size="sm" tone="secondary" as="div">Stopped.</Text>}
                {t.answer && <AnswerMeta answer={t.answer} onDetails={canSeeRequests && t.answer.requestId ? () => setDetails(t.answer!.requestId) : undefined} />}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <PromptInput
            label="Message"
            hideLabel
            value={prompt}
            onChange={setPrompt}
            onSubmit={(p) => void send(p)}
            generating={busy}
            onStop={() => abortRef.current?.abort()}
            suggestions={turns.length === 0 && keyId && model ? SUGGESTIONS : undefined}
            disabled={!keyId || !model}
            placeholder={!keyId ? 'Choose an API key first' : 'Message (Enter to send, Shift+Enter for a new line)'}
            rows={2}
          />
        </Card>
      </div>

      <Card title="Use ClawRouter from other apps" subtitle="Tested applications that work with ClawRouter as their OpenAI- or Anthropic-compatible server. Use an API key of your own." headingLevel={2}>
        <div className="claw-stack">
          <div className="claw-inline">
            <Text as="span">Base URL</Text>
            <code className="claw-mono">{baseUrl}</code>
            <CopyButton value={baseUrl} label="Copy base URL" size="sm" />
          </div>
          <div className="claw-client-list">
            {CHAT_CLIENTS.map((c) => (
              <Card key={c.id} title={c.name} headingLevel={3} flat>
                <div className="claw-stack">
                  <Text as="p" size="sm">{c.summary}</Text>
                  <StatusIndicator tone="success" size="sm">Tested with ClawRouter</StatusIndicator>
                  <div className="claw-inline">
                    <Button size="sm" variant="secondary" onClick={() => setClient(c)}>Show configuration</Button>
                    <Link href={c.guideUrl} target="_blank" rel="noreferrer">Setup guide</Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </Card>

      <RequestDetailDialog id={details} onClose={() => setDetails(null)} />
      <Dialog open={client !== null} onClose={() => setClient(null)} size="lg" title={client ? `${client.name} configuration` : 'Configuration'}
        footer={<Button variant="primary" onClick={() => setClient(null)}>Done</Button>}>
        {client && (
          <div className="claw-stack">
            <Text as="p" size="sm" tone="secondary">{client.where} Replace <span className="claw-mono">crk_your_key</span> with one of your API keys.</Text>
            <pre className="claw-mono claw-code">{client.snippet(baseUrl)}</pre>
            <div className="claw-inline">
              <CopyButton value={client.snippet(baseUrl)} label="Copy configuration" size="sm" />
              <Link href={client.guideUrl} target="_blank" rel="noreferrer">Full setup guide</Link>
            </div>
          </div>
        )}
      </Dialog>
    </Page>
  );
}

/** One line under an answer: the model that answered, tokens, timing, and the request. */
function AnswerMeta({ answer, onDetails }: { answer: PlaygroundAnswer; onDetails?: () => void }) {
  const tokens = answer.inputTokens !== null || answer.outputTokens !== null
    ? `${formatTokens(answer.inputTokens)} in · ${formatTokens(answer.outputTokens)} out`
    : 'tokens not reported';
  const parts = [
    answer.model ?? 'unknown model',
    answer.attempts && answer.attempts > 1 ? `${answer.attempts} attempts` : null,
    tokens,
    `first byte ${formatDuration(answer.firstByteMs)}`,
    `total ${formatDuration(answer.totalMs)}`,
    answer.finishReason && answer.finishReason !== 'stop' ? `ended: ${answer.finishReason}` : null,
  ].filter(Boolean);
  return (
    <div className="claw-chat-meta">
      {answer.notices.map((n, i) => <MessageStrip key={i} tone={n.kind === 'announcement' ? 'information' : 'warning'}>{n.icon} {n.text}</MessageStrip>)}
      {answer.interrupted && <MessageStrip tone="error">{answer.interrupted}</MessageStrip>}
      <Text size="sm" tone="secondary" as="div">
        <span className="claw-mono">{parts.join(' · ')}</span>
        {onDetails && <> · <Link href="#" onClick={(e) => { e.preventDefault(); onDetails(); }}>Request details</Link></>}
      </Text>
    </div>
  );
}
