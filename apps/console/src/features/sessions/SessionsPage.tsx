import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog, Button, MessageStrip, OverflowMenu, Page, Pagination, RefreshControl, StatusIndicator, Table, Text, useToast,
  type TableColumn,
} from '@enterprise-ui/react';
import type { AdminSessionInfo } from '@clawapi/shared';
import { ApiClientError, type PagedResult } from '../../services/api-client.ts';
import { fetchAllSessions, onSessionsChanged, revokeSession, revokeUserSessions } from '../../services/auth.ts';
import { describeUserAgent, formatRelative } from '../../services/format.ts';
import { useAuth, useSession } from '../auth/AuthContext.tsx';

type Pending =
  | { kind: 'one'; session: AdminSessionInfo }
  | { kind: 'user'; session: AdminSessionInfo; own: boolean };

const PAGE_SIZE = 25;
const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * Administration → Sessions: every live console session, with revocation of a
 * single session or all of a user's sessions. Revocation takes effect on the
 * user's next request; their console notices within a minute.
 */
export function SessionsPage() {
  const toast = useToast();
  const { signOut } = useAuth();
  const { user: me } = useSession();
  const [page, setPage] = useState(1);
  const [userFilter, setUserFilter] = useState<{ id: string; name: string } | null>(null);
  const [result, setResult] = useState<PagedResult<AdminSessionInfo> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [pending, setPending] = useState<Pending | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchAllSessions({ page, pageSize: PAGE_SIZE, userId: userFilter?.id }, controller.signal)
      .then((next) => {
        // A revocation can empty the last page: step back instead of showing nothing.
        if (next.items.length === 0 && next.total > 0 && page > 1) {
          setPage(Math.ceil(next.total / PAGE_SIZE));
          return;
        }
        setResult(next);
        setError(null);
        setLastUpdated(new Date());
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Could not load sessions.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, userFilter, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useEffect(() => onSessionsChanged(reload), [reload]);

  const confirm = async () => {
    if (!pending) return;
    const { session } = pending;
    try {
      if (pending.kind === 'one') {
        await revokeSession(session.id);
        if (session.current) {
          await signOut();
          return;
        }
        toast.show({ tone: 'success', title: 'Session signed out', description: `${session.user.displayName} · ${describeUserAgent(session.userAgent)}` });
      } else {
        const { revoked } = await revokeUserSessions(session.user.id, pending.own);
        toast.show({
          tone: 'success',
          title: revoked === 1 ? '1 session signed out' : `${revoked} sessions signed out`,
          description: pending.own ? 'Your other sessions have ended.' : `All sessions of ${session.user.displayName} have ended.`,
        });
      }
    } catch (err) {
      const message = err instanceof ApiClientError && err.status === 404 ? 'That session had already ended.' : err instanceof Error ? err.message : 'Revocation failed.';
      toast.show({ tone: 'error', title: 'Could not sign out', description: message });
    } finally {
      setPending(null);
    }
  };

  const columns: TableColumn<AdminSessionInfo>[] = [
    {
      id: 'user', header: 'User', rowHeader: true, accessor: (s) => s.user.displayName, wrap: true,
      cell: (s) => (
        <span>
          {s.user.displayName} <Text size="sm" tone="secondary">({s.user.username})</Text>
          {s.current && <> <StatusIndicator tone="information" size="sm">This session</StatusIndicator></>}
        </span>
      ),
    },
    { id: 'device', header: 'Device', accessor: (s) => describeUserAgent(s.userAgent), cell: (s) => <span title={s.userAgent ?? undefined}>{describeUserAgent(s.userAgent)}</span> },
    { id: 'ip', header: 'IP address', accessor: (s) => s.ip ?? '—', cell: (s) => <span className="claw-mono">{s.ip ?? '—'}</span> },
    { id: 'created', header: 'Signed in', accessor: (s) => when(s.createdAt) },
    { id: 'seen', header: 'Last active', accessor: (s) => s.lastSeenAt, cell: (s) => <span title={when(s.lastSeenAt)}>{formatRelative(s.lastSeenAt)}</span> },
    { id: 'ends', header: 'Ends', accessor: (s) => when(s.idleExpiresAt) },
    {
      id: 'actions', header: 'Actions', align: 'end',
      cell: (s) => {
        const own = s.user.id === me.id;
        return (
          <OverflowMenu
            label={`Actions for ${s.user.displayName}'s session`}
            items={[
              { id: 'one', label: s.current ? 'Sign out this session (you)' : 'Sign out this session', destructive: true },
              { id: 'user', label: own ? 'Sign out your other sessions' : `Sign out all sessions of ${s.user.displayName}`, destructive: true },
              { type: 'separator' },
              { id: 'filter', label: `Show only ${s.user.displayName}`, disabled: userFilter?.id === s.user.id },
            ]}
            onAction={(id) => {
              if (id === 'one') setPending({ kind: 'one', session: s });
              if (id === 'user') setPending({ kind: 'user', session: s, own });
              if (id === 'filter') {
                setUserFilter({ id: s.user.id, name: s.user.displayName });
                setPage(1);
              }
            }}
          />
        );
      },
    },
  ];

  const total = result?.total ?? 0;
  return (
    <Page
      title="Sessions"
      subtitle="Signed-in console sessions across all users"
      actions={<RefreshControl onRefresh={reload} refreshing={loading} lastUpdated={lastUpdated} intervals={[]} />}
    >
      <MessageStrip tone="information">
        Every signed-in user can manage sessions until roles arrive in phase 3, when this page becomes administrator-only.
      </MessageStrip>
      {error && <MessageStrip tone="error" title="Cannot load sessions">{error}</MessageStrip>}
      {userFilter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eui-space-2, 0.5rem)', flexWrap: 'wrap' }}>
          <Text>Showing sessions of <strong>{userFilter.name}</strong></Text>
          <Button size="sm" variant="tertiary" onClick={() => { setUserFilter(null); setPage(1); }}>Show all users</Button>
        </div>
      )}
      <Table
        caption={`Active sessions (${total})`}
        columns={columns}
        data={result?.items ?? []}
        getRowId={(s) => s.id}
        getRowLabel={(s) => `${s.user.displayName}, ${describeUserAgent(s.userAgent)}`}
        loading={loading && !result}
        emptyState="No active sessions."
      />
      {total > PAGE_SIZE && <Pagination page={page} onPageChange={setPage} totalItems={total} pageSize={PAGE_SIZE} />}

      <AlertDialog
        open={pending !== null}
        tone="warning"
        title={pending?.kind === 'user' ? (pending.own ? 'Sign out your other sessions?' : 'Sign out all sessions of this user?') : 'Sign out this session?'}
        confirmLabel="Sign out"
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      >
        {pending?.kind === 'one' && (pending.session.current
          ? 'This is the session you are using now. You will be signed out immediately.'
          : `${pending.session.user.displayName} will be signed out on ${describeUserAgent(pending.session.userAgent)} and must sign in again.`)}
        {pending?.kind === 'user' && (pending.own
          ? 'Every other browser or device signed in as you will be signed out. This session stays signed in.'
          : `${pending.session.user.displayName} will be signed out everywhere and must sign in again.`)}
      </AlertDialog>
    </Page>
  );
}
