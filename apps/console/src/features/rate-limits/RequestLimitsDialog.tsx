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
import { Button, Dialog, Form, MessageStrip, NumberInput, Text, WithFieldHelp } from '@enterprise-ui/react';
import { DEFAULT_REQUEST_LIMITS, REQUEST_LIMIT_RANGES, type FieldIssue, type RequestLimits } from '@clawrouter/shared';

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'start' } as const;
const group = { border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' } as const;

type Field = { key: keyof RequestLimits; label: string; unit?: string; help: string; step?: number };

/** Shown in this order, in these groups. Labels are also used on the Rate Limits page. */
export const REQUEST_LIMIT_GROUPS: { title: string; note: string; fields: Field[] }[] = [
  {
    title: 'Size and structure',
    note: 'Always on. Checked before anything is sent to a provider; a request past a limit gets 400 with the limit named in error.limit.',
    fields: [
      { key: 'maxRequestBytes', label: 'Request body', unit: 'bytes', step: 1024 * 1024, help: 'Largest body for /v1 requests. A larger body is refused while it is being received, never read in full.' },
      { key: 'maxJsonDepth', label: 'JSON nesting depth', unit: 'levels', help: 'Objects and arrays inside each other. Counted before the body is parsed, so a deeply nested body costs almost nothing to refuse.' },
      { key: 'maxMessages', label: 'Messages per request', help: 'Messages in one conversation, including system and tool messages.' },
      { key: 'maxContentParts', label: 'Content parts per request', help: 'Text, image, audio and file parts across all messages. A message of plain text counts as one.' },
      { key: 'maxToolDefinitions', label: 'Tools per request', help: 'Tools offered to the model in one request (128 at most).' },
      { key: 'maxToolSchemaBytes', label: 'Tool definitions', unit: 'bytes', step: 1024, help: 'All tool definitions together, as JSON.' },
      { key: 'maxImages', label: 'Images per request', help: 'Inline images and image links together (50 at most).' },
      { key: 'maxImageBytes', label: 'Inline image size', unit: 'bytes', step: 1024 * 1024, help: 'One inline image, decoded. Image links are not downloaded by ClawRouter, so only inline images are checked.' },
      { key: 'maxImageDimension', label: 'Image width or height', unit: 'px', step: 256, help: 'Read from the header of each inline image (PNG, JPEG, GIF, WebP). An image whose header cannot be read is refused.' },
    ],
  },
  {
    title: 'Tokens',
    note: 'Optional. Input tokens are estimated at about four characters per token.',
    fields: [
      { key: 'maxInputTokens', label: 'Input tokens', step: 1000, help: 'Estimated tokens of the messages, tool calls and tool definitions. A longer request gets 400.' },
      { key: 'maxOutputTokens', label: 'Output tokens', step: 1000, help: 'A larger max_tokens is lowered to this, and a request without one gets this. Nothing is refused.' },
      { key: 'maxTokensPerRequest', label: 'Tokens per request', step: 1000, help: 'Estimated input plus output. max_tokens is lowered to what the input leaves; when the input alone is this large the request gets 400.' },
    ],
  },
  {
    title: 'In progress and streams',
    note: 'Optional, apart from the stream duration (one hour by default).',
    fields: [
      { key: 'maxConcurrentPerKey', label: 'Requests at once per key', help: 'Requests a key may have in progress at the same time; more get 429. A stream counts until it ends.' },
      { key: 'maxConcurrentPerUser', label: 'Requests at once per user', help: 'All keys of one user together.' },
      { key: 'maxStreamSeconds', label: 'Stream duration', unit: 's', step: 60, help: 'A streamed answer still running after this is ended with an error event, and the provider call is stopped. Its usage so far is counted.' },
    ],
  },
];

/** Edits the request resource limits (SEC-006); the server validates them again on save. */
export function RequestLimitsDialog({ open, value, onClose, onSave, saving, serverIssues, serverError }: {
  open: boolean;
  value: RequestLimits | null;
  onClose: () => void;
  onSave: (limits: RequestLimits) => void;
  saving: boolean;
  serverIssues: FieldIssue[];
  serverError: string | null;
}) {
  const [draft, setDraft] = useState<RequestLimits | null>(null);
  useEffect(() => {
    if (open && value) setDraft({ ...value });
  }, [open, value]);
  if (!draft) return null;
  const issue = (key: string) => serverIssues.find((i) => i.path === `requestLimits.${key}`)?.message;

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Edit request limits"
      footer={
        <>
          <Button variant="primary" loading={saving} onClick={() => onSave(draft)}>Save</Button>
          <Button variant="secondary" onClick={() => setDraft({ ...DEFAULT_REQUEST_LIMITS })}>Use defaults</Button>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
        </>
      }>
      <Form onSubmit={(e) => { e.preventDefault(); onSave(draft); }} noValidate>
        {serverError && <MessageStrip tone="error" announce="assertive">{serverError}</MessageStrip>}
        {REQUEST_LIMIT_GROUPS.map((g) => (
          <fieldset key={g.title} style={group}>
            <legend><Text as="strong">{g.title}</Text></legend>
            <Text size="sm" tone="secondary">{g.note}</Text>
            <div style={grid}>
              {g.fields.map((f) => {
                const range = REQUEST_LIMIT_RANGES[f.key];
                const description = `${range.min.toLocaleString('en-US')}–${range.max.toLocaleString('en-US')}${range.nullable ? '; empty = no limit' : ''}`;
                return (
                  <WithFieldHelp key={f.key} label={f.label} help={f.help}>
                    <NumberInput label={f.label} unit={f.unit} description={description} placeholder={range.nullable ? 'No limit' : undefined}
                      min={range.min} max={range.max} step={f.step ?? 1} value={draft[f.key]} error={issue(f.key)}
                      onChange={(n) => setDraft({ ...draft, [f.key]: range.nullable ? n : (n ?? DEFAULT_REQUEST_LIMITS[f.key]) })} />
                  </WithFieldHelp>
                );
              })}
            </div>
          </fieldset>
        ))}
      </Form>
    </Dialog>
  );
}
