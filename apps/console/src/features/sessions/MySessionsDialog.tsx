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

import { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, MessageStrip, StatusIndicator, Table, VisuallyHidden, type TableColumn } from '@enterprise-ui/react';
import type { SessionInfo } from '@clawrouter/shared';
import { fetchMySessions, onSessionsChanged, revokeMyOtherSessions, revokeMySession } from '../../services/auth.ts';
import { describeUserAgent } from '../../services/format.ts';

const when = (iso: string) => new Date(iso).toLocaleString();

/** The signed-in user's own sessions, with sign-out for other devices. */
export function MySessionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSessions(await fetchMySessions());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load sessions.');
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    return onSessionsChanged(() => void load());
  }, [open, load]);

  const revoke = async (id: string) => {
    setRevoking(id);
    try {
      await revokeMySession(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign out that session.');
    } finally {
      setRevoking(null);
    }
  };

  const revokeOthers = async () => {
    setRevoking('others');
    try {
      await revokeMyOtherSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign out your other sessions.');
    } finally {
      setRevoking(null);
    }
  };
  const others = sessions?.filter((s) => !s.current).length ?? 0;

  const columns: TableColumn<SessionInfo>[] = [
    { id: 'device', header: 'Device', rowHeader: true, wrap: true, accessor: (s) => describeUserAgent(s.userAgent), cell: (s) => (
      <>
        <span title={s.userAgent ?? undefined}>{describeUserAgent(s.userAgent)}</span> {s.current && <StatusIndicator tone="information" size="sm">This session</StatusIndicator>}
      </>
    ) },
    { id: 'ip', header: 'IP address', accessor: (s) => s.ip ?? '—', cell: (s) => <span className="claw-mono">{s.ip ?? '—'}</span> },
    { id: 'created', header: 'Signed in', accessor: (s) => when(s.createdAt) },
    { id: 'expires', header: 'Ends', accessor: (s) => when(s.idleExpiresAt) },
    { id: 'actions', header: <VisuallyHidden>Actions</VisuallyHidden>, headerText: 'Actions', align: 'end', cell: (s) =>
      s.current ? null : (
        <Button size="sm" variant="tertiary" loading={revoking === s.id} onClick={() => void revoke(s.id)}>Sign out</Button>
      ) },
  ];

  return (
    <Dialog open={open} onClose={onClose} title="My sessions" size="lg" footer={
      <>
        <Button variant="tertiary" disabled={others === 0} loading={revoking === 'others'} onClick={() => void revokeOthers()}>
          Sign out all other sessions
        </Button>
        <Button onClick={onClose}>Close</Button>
      </>
    }>
      {error && <MessageStrip tone="error">{error}</MessageStrip>}
      <Table caption="Active sessions" hideCaption columns={columns} data={sessions ?? []} getRowId={(s) => s.id} loading={sessions === null && !error} emptyState="No active sessions." />
    </Dialog>
  );
}
