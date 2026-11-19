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
import { Button, Card, MessageStrip, Switch, Text, TextArea, useToast, WithFieldHelp } from '@enterprise-ui/react';
import { NOTICE_TEXT_MAX, SYSTEM_NOTICE_KINDS, SYSTEM_NOTICE_LABELS, type NoticeMessage, type NoticeMessages, type SystemNoticeKind } from '@clawrouter/shared';
import { useResource } from '../../hooks/useResource.ts';
import { ApiClientError } from '../../services/api-client.ts';
import { fetchNoticeMessages, resetNoticeMessages, saveNoticeMessages } from '../../services/notices.ts';
import { useRealtimeEvent } from '../realtime/RealtimeContext.tsx';

type Draft = Record<SystemNoticeKind, NoticeMessage>;
const pick = (m: NoticeMessages): Draft => ({ health: m.health, failover: m.failover });

/** Settings → Client notices: the messages ClawRouter sends on its own (needs announcements.manage). */
export function NoticeMessagesCard() {
  const toast = useToast();
  const { data, error, reload } = useResource(fetchNoticeMessages);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useRealtimeEvent(['settings.changed'], () => reload(), 300);
  useEffect(() => { if (data) setDraft(pick(data)); }, [data]);

  if (error) return <MessageStrip tone="error" title="Cannot load the notice messages">{error}</MessageStrip>;
  if (!draft || !data) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(pick(data));
  const set = (kind: SystemNoticeKind, patch: Partial<NoticeMessage>) => setDraft({ ...draft, [kind]: { ...draft[kind], ...patch } });

  const save = async () => {
    setSaving(true);
    setIssues({});
    try {
      await saveNoticeMessages(draft);
      toast.show({ tone: 'success', title: 'Notice messages saved' });
      reload();
    } catch (err) {
      if (err instanceof ApiClientError && err.issues.length) setIssues(Object.fromEntries(err.issues.map((i) => [i.path, i.message])));
      else toast.show({ tone: 'error', title: 'Could not save', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    try {
      await resetNoticeMessages();
      toast.show({ tone: 'success', title: 'Built-in messages restored' });
      reload();
    } catch (err) {
      toast.show({ tone: 'error', title: 'Could not reset', description: err instanceof Error ? err.message : undefined, duration: 10_000 });
    }
  };

  return (
    <Card title="Notice messages" subtitle="What ClawRouter says on its own. Announcements are written under Administration → Announcements." headingLevel={2}>
      <div style={{ display: 'grid', gap: 'var(--eui-space-4, 1rem)', maxWidth: '44rem' }}>
        {SYSTEM_NOTICE_KINDS.map((kind) => (
          <div key={kind} style={{ display: 'grid', gap: 'var(--eui-space-2, 0.5rem)' }}>
            <WithFieldHelp label={SYSTEM_NOTICE_LABELS[kind].label} help={`Sent when ${SYSTEM_NOTICE_LABELS[kind].when.charAt(0).toLowerCase()}${SYSTEM_NOTICE_LABELS[kind].when.slice(1)} At most once per API key in the repeat interval above.`} inline>
              <Switch label={`${SYSTEM_NOTICE_LABELS[kind].label} notice`} checked={draft[kind].enabled} onChange={(on) => set(kind, { enabled: on })} />
            </WithFieldHelp>
            <TextArea
              label="Message" rows={2} value={draft[kind].text} disabled={!draft[kind].enabled}
              maxLength={NOTICE_TEXT_MAX} description={`One line, up to ${NOTICE_TEXT_MAX} characters.`}
              error={issues[`${kind}.text`]}
              onChange={(e) => set(kind, { text: e.target.value })}
            />
          </div>
        ))}
        <Text size="sm" tone="secondary">In replies they appear as “⚠️ ClawRouter: …” on the first line; in the header as JSON.</Text>
        <div style={{ display: 'flex', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>Save messages</Button>
          <Button variant="tertiary" onClick={() => void reset()} disabled={!data.updatedAt}>Restore built-in messages</Button>
        </div>
      </div>
    </Card>
  );
}
