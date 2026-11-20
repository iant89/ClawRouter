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

import { useState } from 'react';
import { Button, MessageStrip, StatusIndicator, Text } from '@enterprise-ui/react';
import type { RequestAttachment, RequestContent, RequestToolCall } from '@clawrouter/shared';
import { fetchRequestContent } from '../../services/requests.ts';

const bytesText = (n: number | null) => (n === null ? '' : n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const attachmentText = (a: RequestAttachment) =>
  [a.type === 'pdf' ? 'PDF' : a.type === 'image' ? 'Image' : 'Audio', a.mediaType, bytesText(a.bytes), a.name ? (a.type === 'image' && !a.mediaType ? `from ${a.name}` : a.name) : null].filter(Boolean).join(' · ');

function ToolCalls({ calls }: { calls: RequestToolCall[] }) {
  return (
    <>
      {calls.map((c) => (
        <pre key={c.id || c.name} className="claw-code claw-mono claw-capture-body">{`${c.name}(${c.arguments})${c.id ? `  [${c.id}]` : ''}`}</pre>
      ))}
    </>
  );
}

const block = { display: 'grid', gap: 'var(--eui-space-1, 0.25rem)' } as const;

/**
 * The prompt and reply of one request, kept because request logging was Full
 * (SEC-009). Loaded only when asked for, behind a privacy notice: these are
 * users' own words. Needs requests.content.
 */
export function RequestContentPanel({ requestId }: { requestId: string }) {
  const [content, setContent] = useState<RequestContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchRequestContent(requestId)
      .then(setContent)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the prompt and reply.'))
      .finally(() => setLoading(false));
  };

  return (
    <section aria-label="Prompt and reply" style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
      <MessageStrip tone="warning" title="Prompt and reply stored">
        Request logging was set to Full when this request was made, so what the user sent and received was kept. It is
        their own words and may be personal or confidential: open it only when you need to. Secret-shaped text was
        removed before storing; attachments are described, never kept.
      </MessageStrip>
      {!content && <div><Button onClick={load} loading={loading}>Show prompt and reply</Button></div>}
      {error && <MessageStrip tone="error">{error}</MessageStrip>}
      {content && (
        <>
          {content.truncated && <Text size="sm" tone="secondary">Some text was cut or left out to keep at most 1 MB for this request.</Text>}
          {content.tools.length > 0 && <Text size="sm">Tools offered: <span className="claw-mono">{content.tools.join(', ')}</span></Text>}
          {content.messages.map((m, i) => (
            <div key={i} style={block}>
              <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'center', flexWrap: 'wrap' }}>
                <StatusIndicator tone="neutral" size="sm">{m.role}</StatusIndicator>
                {m.toolCallId && <Text size="sm" tone="secondary">answers <span className="claw-mono">{m.toolCallId}</span></Text>}
                {m.truncated && <Text size="sm" tone="secondary">(cut to fit)</Text>}
              </div>
              {m.content && <pre className="claw-code claw-capture-body">{m.content}</pre>}
              {m.attachments?.map((a, j) => <Text key={j} size="sm">Attachment: {attachmentText(a)}</Text>)}
              {m.toolCalls && <ToolCalls calls={m.toolCalls} />}
            </div>
          ))}
          {content.input && (
            <div style={block}>
              <StatusIndicator tone="neutral" size="sm">input</StatusIndicator>
              {content.input.map((s, i) => <pre key={i} className="claw-code claw-capture-body">{s}</pre>)}
            </div>
          )}
          <div style={block}>
            <StatusIndicator tone={content.response ? 'success' : 'neutral'} size="sm">reply</StatusIndicator>
            {!content.response && <Text size="sm" tone="secondary">No reply: the request ended before one.</Text>}
            {content.response?.embeddings !== undefined && <Text size="sm">{content.response.embeddings} embedding(s) returned (vectors are not stored).</Text>}
            {content.response?.reasoning && <pre className="claw-code claw-capture-body" aria-label="Reasoning">{content.response.reasoning}</pre>}
            {content.response?.content && <pre className="claw-code claw-capture-body">{content.response.content}</pre>}
            {content.response && content.response.toolCalls.length > 0 && <ToolCalls calls={content.response.toolCalls} />}
            {content.response?.finishReason && <Text size="sm" tone="secondary">Finished: {content.response.finishReason}</Text>}
          </div>
        </>
      )}
    </section>
  );
}
