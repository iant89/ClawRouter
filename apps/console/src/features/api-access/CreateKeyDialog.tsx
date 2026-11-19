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
import { Button, CopyButton, Dialog, FieldHelp, Form, Input, MessageStrip, MultiSelect, Switch, Text, WithFieldHelp } from '@enterprise-ui/react';
import type { CreateApiKeyRequest, CreatedApiKey, RateLimit } from '@clawrouter/shared';
import { KeyLimitFields } from './KeyLimitDialog.tsx';
import { defaultDraft, ExpiryField, toKeyExpiry, type ExpiryDraft } from './ExpiryField.tsx';
import { useSession } from '../auth/AuthContext.tsx';

/**
 * Create an API key. After creation the dialog shows the key once, with a copy
 * button and a curl example; closing the dialog discards it from memory.
 */
export function CreateKeyDialog({ open, modelOptions, onClose, onCreate, created, saving, serverError, withLimits = true, title = 'Create API key', intro }: {
  /** Administrators set per-key limits; own keys use the default. */
  withLimits?: boolean;
  title?: string;
  intro?: React.ReactNode;
  open: boolean;
  /** Aliases and model references a key can be limited to. */
  modelOptions: { value: string; label: string; description?: string }[];
  onClose: () => void;
  onCreate: (body: CreateApiKeyRequest) => void;
  created: CreatedApiKey | null;
  saving: boolean;
  serverError: string | null;
}) {
  // The signed-in user creates the key: their limit applies (none for Administrators).
  const { keyLifetimeLimitHours: maxHours, mcpServer } = useSession();
  const [name, setName] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<ExpiryDraft>(defaultDraft(maxHours));
  const [rateLimit, setRateLimit] = useState<RateLimit | null>(null);
  const [mcpAccess, setMcpAccess] = useState(false);
  const [replyNotices, setReplyNotices] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setModels([]);
    setExpiry(defaultDraft(maxHours));
    setRateLimit(null);
    setMcpAccess(false);
    setReplyNotices(true);
    setError(null);
  }, [open]);

  const submit = () => {
    if (!name.trim()) return setError('Give the key a name, e.g. the application that will use it.');
    const { expiry: chosen, error: invalid } = toKeyExpiry(expiry, maxHours);
    if (!chosen) return setError(invalid ?? 'Check the expiry.');
    setError(null);
    onCreate({ name: name.trim(), allowedModels: models, expiry: chosen, mcpAccess: mcpServer && mcpAccess, replyNotices, ...(withLimits ? { rateLimit } : {}) });
  };

  if (created) {
    const example = `curl ${location.origin}/v1/chat/completions \\\n  -H "Authorization: Bearer ${created.secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${created.key.allowedModels[0] ?? 'MODEL'}", "messages": [{"role": "user", "content": "Hello"}]}'`;
    return (
      <Dialog open={open} onClose={onClose} size="lg" title={`API key "${created.key.name}" created`}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <MessageStrip tone="warning" title="Copy the key now">
          This is the only time the key is shown. ClawRouter stores only a hash of it; if it is lost, revoke it and create a new one.
        </MessageStrip>
        <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'center', flexWrap: 'wrap' }}>
          <code className="claw-mono claw-secret" aria-label="API key">{created.secret}</code>
          <CopyButton value={created.secret} label="Copy key" />
        </div>
        <Text as="strong">Example request</Text>
        <pre className="claw-mono claw-code">{example}</pre>
        <div><CopyButton value={example} label="Copy example" size="sm" /></div>
        {mcpServer && created.key.mcpAccess && <McpSetup secret={created.secret} />}
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={submit}>Create key</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <Form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        {(error ?? serverError) && <MessageStrip tone="error" announce="assertive">{error ?? serverError}</MessageStrip>}
        {intro}
        <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={100}
          endAdornment={<FieldHelp label="Name">Who or what uses this key, e.g. ci-pipeline. Shown in request history and usage.</FieldHelp>} />
        <MultiSelect label="Allowed models" description="Leave empty to allow every model and alias." options={modelOptions} value={models} onChange={setModels} placeholder="Any model" />
        <ExpiryField value={expiry} onChange={setExpiry} maxHours={maxHours} />
        {withLimits && <KeyLimitFields value={rateLimit} onChange={setRateLimit} />}
        <WithFieldHelp label="Notices in replies" help={<>ClawRouter can start a reply with a one-line notice, such as degraded health or an announcement, for people reading in a chat app. Turn it off for scripts and apps that read replies as data. Notices are also sent in the X-ClawRouter-Notices header either way.</>}>
          <Switch label="Notices at the start of replies" checked={replyNotices} onChange={setReplyNotices} />
        </WithFieldHelp>
        {/* Only while the MCP server is on (Settings; off by default). */}
        {mcpServer && (
          <WithFieldHelp label="MCP access" help={<>Lets an agent such as Claude Code connect to ClawRouter's MCP server (/v1/mcp) with this key and ask about health, usage, requests, providers and models. The tools only read, and answer with your permissions: what you cannot see in the console, the agent cannot see either. Leave it off for keys that only call models.</>}>
            <Switch label="Allow MCP access (read-only tools for agents)" checked={mcpAccess} onChange={setMcpAccess} />
          </WithFieldHelp>
        )}
      </Form>
    </Dialog>
  );
}

/** How to connect an agent to ClawRouter's MCP server with the key just created. */
function McpSetup({ secret }: { secret: string }) {
  const url = `${location.origin}/v1/mcp`;
  const claudeCode = `claude mcp add --transport http clawrouter ${url} \\\n  --header "Authorization: Bearer ${secret}"`;
  const config = JSON.stringify({ mcpServers: { clawrouter: { type: 'http', url, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)', marginBlockStart: 'var(--eui-space-3, 0.75rem)' }}>
      <Text as="strong">Connect an agent (MCP)</Text>
      <Text tone="secondary">Claude Code:</Text>
      <pre className="claw-mono claw-code">{claudeCode}</pre>
      <div><CopyButton value={claudeCode} label="Copy command" size="sm" /></div>
      <Text tone="secondary">Other clients that read an <span className="claw-mono">mcpServers</span> file:</Text>
      <pre className="claw-mono claw-code">{config}</pre>
      <div><CopyButton value={config} label="Copy configuration" size="sm" /></div>
    </div>
  );
}
