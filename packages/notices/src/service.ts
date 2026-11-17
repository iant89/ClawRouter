import type { AuditService } from '@clawrouter/audit';
import { errors, newId, type EventBus, type Logger } from '@clawrouter/core';
import type { JsonValue, SettingsRepository } from '@clawrouter/database';
import {
  ANNOUNCEMENT_CHANNELS, ANNOUNCEMENT_FREQUENCIES, ANNOUNCEMENTS_ACTIVE_MAX, DEFAULT_NOTICE_MESSAGES, NOTICE_TEXT_MAX, SYSTEM_NOTICE_KINDS,
  type AnnouncementInfo, type AnnouncementInput, type FieldIssue, type Notice, type NoticeMessage, type NoticeMessages, type NoticeSource, type SystemNoticeKind,
} from '@clawrouter/shared';
import { oneLine } from './format.ts';
import { dayKey, validTimeZone, weekKey } from './periods.ts';
import type { AnnouncementRecord, AnnouncementRepository } from './repository.ts';

const MESSAGES_KEY = 'notices.messages';
/** Active announcements are read from the database at most this often (changes made here clear it at once). */
const ACTIVE_CACHE_MS = 5_000;

export interface NoticeActor {
  id: string;
  username: string;
}
export interface NoticeClient {
  ip: string | null;
  requestId?: string | null;
}

export type NoticeService = ReturnType<typeof createNoticeService>;

/**
 * Client notices (owner request, 2026-11-17). Decides, for each gateway response,
 * which notices go in the header and which at the start of the reply:
 *   - system notices (degraded health, failover), with editable messages, at most
 *     once per `noticeIntervalMinutes` per API key and kind (held in memory);
 *   - announcements, each sent to every user (the key's owner) on its own schedule:
 *     every request, once, once a day or once a week, between its start and expiry.
 * An announcement counts as delivered only when one of its channels was used.
 */
export function createNoticeService(options: {
  repo: AnnouncementRepository;
  settingsRepo: SettingsRepository;
  /** The numeric settings, read at use time. */
  settings: { headerEnabled(): boolean; replyEnabled(): boolean; cleanupEnabled(): boolean; intervalMinutes(): number };
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
}) {
  const { repo, settingsRepo, settings, audit, events, log } = options;
  const now = options.now ?? (() => new Date());
  /** Last system notice per key and kind (ms). */
  const lastSystem = new Map<string, number>();
  let platformDegraded = false;
  let activeCache: { at: number; list: AnnouncementRecord[] } | null = null;

  events?.on('health.changed', (e) => {
    platformDegraded = e.current === 'DEGRADED' || e.current === 'OFFLINE';
  });

  const record = (action: 'ANNOUNCEMENT_CREATED' | 'ANNOUNCEMENT_UPDATED' | 'ANNOUNCEMENT_DELETED' | 'SETTINGS_CHANGED', actor: NoticeActor, client: NoticeClient, resourceId: string | undefined, metadata: Record<string, unknown>) =>
    audit.record({ action, result: 'SUCCESS', resource: resourceId ? 'announcement' : 'settings', resourceId, actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null, metadata });

  // --- default messages ------------------------------------------------------
  function messages(): NoticeMessages {
    const s = settingsRepo.get(MESSAGES_KEY);
    const v = (s?.value ?? {}) as Partial<Record<SystemNoticeKind, Partial<NoticeMessage>>>;
    const pick = (k: SystemNoticeKind): NoticeMessage => ({
      enabled: typeof v[k]?.enabled === 'boolean' ? v[k]!.enabled! : DEFAULT_NOTICE_MESSAGES[k].enabled,
      text: typeof v[k]?.text === 'string' && v[k]!.text!.trim() ? v[k]!.text! : DEFAULT_NOTICE_MESSAGES[k].text,
    });
    return { health: pick('health'), failover: pick('failover'), updatedAt: s?.updatedAt ?? null };
  }

  const checkText = (value: string, path: string, issues: FieldIssue[]): string => {
    const text = oneLine(value);
    if (!text || text.length > NOTICE_TEXT_MAX) issues.push({ path, message: `must be 1–${NOTICE_TEXT_MAX} characters on one line` });
    return text;
  };

  // --- announcements -----------------------------------------------------------
  function active(): AnnouncementRecord[] {
    const t = now().getTime();
    if (!activeCache || t - activeCache.at > ACTIVE_CACHE_MS) activeCache = { at: t, list: repo.active(now().toISOString()) };
    // The cache may hold one that expired or has not started in the last few seconds.
    const iso = now().toISOString();
    return activeCache.list.filter((a) => (!a.startsAt || a.startsAt <= iso) && (!a.expiresAt || a.expiresAt > iso));
  }
  const changed = () => {
    activeCache = null;
  };

  function checkInput(input: Partial<AnnouncementInput>, base: AnnouncementRecord | null): Omit<AnnouncementRecord, 'id' | 'createdAt' | 'createdBy' | 'updatedAt'> {
    const issues: FieldIssue[] = [];
    const message = input.message === undefined && base ? base.message : checkText(input.message ?? '', 'message', issues);
    const frequency = input.frequency ?? base?.frequency;
    if (!frequency || !ANNOUNCEMENT_FREQUENCIES.includes(frequency)) issues.push({ path: 'frequency', message: `must be one of ${ANNOUNCEMENT_FREQUENCIES.join(', ')}` });
    const channel = input.channel ?? base?.channel;
    if (!channel || !ANNOUNCEMENT_CHANNELS.includes(channel)) issues.push({ path: 'channel', message: `must be one of ${ANNOUNCEMENT_CHANNELS.join(', ')}` });
    const timeZone = input.timeZone ?? base?.timeZone;
    if (!validTimeZone(timeZone)) issues.push({ path: 'timeZone', message: 'must be an IANA time zone, e.g. Europe/London' });
    const when = (value: string | null | undefined, fallback: string | null, path: string): string | null => {
      if (value === undefined) return fallback;
      if (value === null) return null;
      const t = Date.parse(value);
      if (Number.isNaN(t)) {
        issues.push({ path, message: 'must be an ISO date-time' });
        return null;
      }
      return new Date(t).toISOString();
    };
    const startsAt = when(input.startsAt, base?.startsAt ?? null, 'startsAt');
    const expiresAt = when(input.expiresAt, base?.expiresAt ?? null, 'expiresAt');
    if (expiresAt && input.expiresAt !== undefined && expiresAt <= now().toISOString()) issues.push({ path: 'expiresAt', message: 'must be in the future' });
    if (expiresAt && startsAt && expiresAt <= startsAt) issues.push({ path: 'expiresAt', message: 'must be after the start' });
    const enabled = input.enabled ?? base?.enabled ?? true;
    if (issues.length) throw errors.validation(issues);
    return { message, frequency: frequency!, channel: channel!, startsAt, expiresAt, timeZone: timeZone!, enabled };
  }

  /** Whether `a` is due for `recipient` now, by its frequency. */
  function due(a: AnnouncementRecord, recipient: string, at: Date): boolean {
    if (a.frequency === 'every_request') return true;
    const last = repo.delivery(a.id, recipient);
    if (!last) return true;
    if (a.frequency === 'once') return false;
    const lastAt = new Date(last.lastAt);
    return a.frequency === 'daily' ? dayKey(lastAt, a.timeZone) !== dayKey(at, a.timeZone) : weekKey(lastAt, a.timeZone) !== weekKey(at, a.timeZone);
  }

  const source: NoticeSource = {
    noticesFor({ keyId, ownerId, failedOver, providerStatus, replyAllowed }) {
      const header: Notice[] = [];
      const reply: Notice[] = [];
      const headerOn = settings.headerEnabled();
      const replyOn = settings.replyEnabled() && replyAllowed;
      if (!headerOn && !replyOn) return { header, reply };
      const at = now();

      // System notices: at most once per interval per key and kind.
      const msgs = messages();
      const interval = settings.intervalMinutes() * 60_000;
      const system: [SystemNoticeKind, boolean][] = [
        ['health', platformDegraded || providerStatus === 'DEGRADED' || providerStatus === 'OFFLINE'],
        ['failover', failedOver],
      ];
      for (const [kind, applies] of system) {
        if (!applies || !msgs[kind].enabled) continue;
        const k = `${keyId}:${kind}`;
        const last = lastSystem.get(k);
        if (last !== undefined && at.getTime() - last < interval) continue;
        lastSystem.set(k, at.getTime());
        const n: Notice = { kind, text: msgs[kind].text, channel: 'both' };
        if (headerOn) header.push(n);
        if (replyOn) reply.push(n);
      }
      if (lastSystem.size > 50_000) lastSystem.clear(); // bound memory; at worst a notice repeats early

      // Announcements, per recipient: the key's owner (or the key itself when it has none).
      const recipient = ownerId ?? `key:${keyId}`;
      try {
        for (const a of active()) {
          const toHeader = headerOn && a.channel !== 'reply';
          const toReply = replyOn && a.channel !== 'header';
          if (!toHeader && !toReply) continue; // not delivered: try again on a request that can carry it
          if (!due(a, recipient, at)) continue;
          const n: Notice = { kind: 'announcement', text: a.message, channel: a.channel };
          if (toHeader) header.push(n);
          if (toReply) reply.push(n);
          repo.recordDelivery(a.id, recipient, at.toISOString());
        }
      } catch (error) {
        // A notice never fails a request.
        log?.error('announcements could not be read', { component: 'notices', error });
      }
      return { header, reply };
    },
    cleanupEnabled: () => settings.cleanupEnabled(),
  };

  return {
    source,
    messages,

    updateMessages(actor: NoticeActor, input: Partial<Record<SystemNoticeKind, Partial<NoticeMessage>>>, client: NoticeClient): NoticeMessages {
      const current = messages();
      const issues: FieldIssue[] = [];
      const next: Record<SystemNoticeKind, NoticeMessage> = { health: current.health, failover: current.failover };
      for (const kind of SYSTEM_NOTICE_KINDS) {
        const v = input[kind];
        if (v === undefined) continue;
        next[kind] = {
          enabled: v.enabled ?? current[kind].enabled,
          text: v.text === undefined ? current[kind].text : checkText(v.text, `${kind}.text`, issues),
        };
      }
      if (issues.length) throw errors.validation(issues);
      const changes: Record<string, unknown> = {};
      for (const kind of SYSTEM_NOTICE_KINDS) {
        if (JSON.stringify(next[kind]) !== JSON.stringify(current[kind])) changes[kind] = { from: current[kind], to: next[kind] };
      }
      if (Object.keys(changes).length) {
        settingsRepo.set(MESSAGES_KEY, next as unknown as JsonValue);
        record('SETTINGS_CHANGED', actor, client, undefined, { noticeMessages: changes });
        events?.emit('settings.changed', { key: MESSAGES_KEY });
      }
      return messages();
    },

    /** Restores the built-in messages. */
    resetMessages(actor: NoticeActor, client: NoticeClient): NoticeMessages {
      if (settingsRepo.delete(MESSAGES_KEY)) {
        record('SETTINGS_CHANGED', actor, client, undefined, { noticeMessages: 'reset to the built-in messages' });
        events?.emit('settings.changed', { key: MESSAGES_KEY });
      }
      return messages();
    },

    listAnnouncements(): AnnouncementInfo[] {
      this.purgeExpired();
      return repo.list();
    },

    createAnnouncement(actor: NoticeActor, input: AnnouncementInput, client: NoticeClient): AnnouncementInfo {
      const fields = checkInput(input, null);
      if (repo.active(now().toISOString()).length >= ANNOUNCEMENTS_ACTIVE_MAX) {
        throw errors.conflict(`At most ${ANNOUNCEMENTS_ACTIVE_MAX} announcements can be active at once. Delete or turn one off first.`);
      }
      const at = now().toISOString();
      const a: AnnouncementRecord = { id: newId(), ...fields, createdAt: at, createdBy: actor.id, updatedAt: at };
      repo.insert(a);
      changed();
      record('ANNOUNCEMENT_CREATED', actor, client, a.id, { message: a.message, frequency: a.frequency, channel: a.channel, startsAt: a.startsAt, expiresAt: a.expiresAt, enabled: a.enabled });
      return repo.list().find((x) => x.id === a.id)!;
    },

    updateAnnouncement(actor: NoticeActor, id: string, input: Partial<AnnouncementInput>, client: NoticeClient): AnnouncementInfo {
      const before = repo.get(id);
      if (!before) throw errors.notFound('Announcement not found.');
      const fields = checkInput(input, before);
      const after: AnnouncementRecord = { ...before, ...fields, updatedAt: now().toISOString() };
      const changes: Record<string, unknown> = {};
      for (const k of ['message', 'frequency', 'channel', 'startsAt', 'expiresAt', 'timeZone', 'enabled'] as const) {
        if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
      }
      if (Object.keys(changes).length) {
        repo.update(after);
        changed();
        record('ANNOUNCEMENT_UPDATED', actor, client, id, changes);
      }
      return repo.list().find((x) => x.id === id)!;
    },

    deleteAnnouncement(actor: NoticeActor, id: string, client: NoticeClient): void {
      const before = repo.get(id);
      if (!before || !repo.delete(id)) throw errors.notFound('Announcement not found.');
      changed();
      record('ANNOUNCEMENT_DELETED', actor, client, id, { message: before.message });
    },

    /** Announcements past their expiry delete themselves (run on a timer and before listing). */
    purgeExpired(): number {
      const ids = repo.deleteExpired(now().toISOString());
      if (ids.length) {
        changed();
        log?.info('expired announcements deleted', { component: 'notices', ids });
      }
      return ids.length;
    },
  };
}
