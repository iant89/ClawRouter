import type { AuditService } from '@clawrouter/audit';
import { AppError, errors, newId, type Logger } from '@clawrouter/core';
import {
  CAPTURE_EXPORT_MAX, MANUAL_CAPTURE_MAX_COUNT, MANUAL_CAPTURE_MAX_MINUTES,
  type CaptureDetail, type CaptureExportFile, type CaptureSink, type CaptureState, type ManualCaptureInfo, type StartManualCaptureRequest,
} from '@clawrouter/shared';
import { maskCapture } from './mask.ts';
import type { CaptureQuery, CaptureRepository } from './repository.ts';

export interface CaptureActor {
  id: string;
  username: string;
}
export interface CaptureClientInfo {
  ip: string | null;
  requestId?: string | null;
}

export type CaptureService = ReturnType<typeof createCaptureService>;

/**
 * Provider captures (owner request, 2026-11-17). Captures are kept until
 * deleted, capped by count; exports can mask message text. The manual capture
 * lives in memory (one at a time, per process) and stops after its count or time.
 */
export function createCaptureService(options: {
  repo: CaptureRepository;
  audit: AuditService;
  /** The capturesEnabled and capturesMaxCount settings, read at use time. */
  settings: { enabled(): boolean; maxCount(): number };
  version: string;
  log?: Logger;
  now?: () => Date;
}) {
  const { repo, audit, settings, log } = options;
  const now = options.now ?? (() => new Date());
  let manual: ManualCaptureInfo | null = null;

  /** The manual capture, unless it has run out (count or time). */
  function activeManual(): ManualCaptureInfo | null {
    if (manual && (manual.remaining <= 0 || Date.parse(manual.expiresAt) <= now().getTime())) manual = null;
    return manual;
  }

  const record = (action: 'CAPTURE_STARTED' | 'CAPTURE_STOPPED' | 'CAPTURES_EXPORTED' | 'CAPTURES_DELETED', actor: CaptureActor, client: CaptureClientInfo, metadata: Record<string, unknown>) =>
    audit.record({ action, result: 'SUCCESS', resource: 'captures', actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null, metadata });

  const sink: CaptureSink = {
    recording: () => settings.enabled(),
    claimManual(match) {
      const m = activeManual();
      if (!m || !settings.enabled()) return false;
      if (m.providerId && !match.providerIds.includes(m.providerId)) return false;
      if (m.model && m.model !== match.requestedModel && !match.modelRefs.includes(m.model)) return false;
      m.remaining -= 1;
      return true;
    },
    save(capture) {
      try {
        const stored: CaptureDetail = { ...capture, id: `cap_${newId()}`, createdAt: now().toISOString(), sizeBytes: 0 };
        stored.sizeBytes = new TextEncoder().encode(JSON.stringify(stored)).byteLength;
        repo.insert(stored);
        const trimmed = repo.trim(settings.maxCount());
        log?.info('provider capture saved', { component: 'captures', captureId: stored.id, trigger: stored.trigger, requestId: stored.requestId, trimmed });
      } catch (error) {
        // A capture is a diagnostic: failing to keep one never fails the request.
        log?.error('provider capture could not be saved', { component: 'captures', error });
      }
    },
  };

  return {
    sink,

    state(): CaptureState {
      return { enabled: settings.enabled(), manual: activeManual(), stored: repo.count(), maxCount: settings.maxCount() };
    },

    list(q: CaptureQuery) {
      return repo.list(q);
    },

    get(id: string): CaptureDetail {
      const c = repo.get(id);
      if (!c) throw errors.notFound('Capture not found.');
      return c;
    },

    startManual(actor: CaptureActor, input: StartManualCaptureRequest, client: CaptureClientInfo): ManualCaptureInfo {
      if (!settings.enabled()) throw new AppError('CONFLICT', 'Provider captures are off. Turn them on in Settings → Data retention first.');
      const at = now();
      manual = {
        providerId: input.providerId ?? null, model: input.model ?? null,
        total: input.count, remaining: input.count,
        startedAt: at.toISOString(), expiresAt: new Date(at.getTime() + input.minutes * 60_000).toISOString(), startedBy: actor.username,
      };
      record('CAPTURE_STARTED', actor, client, { providerId: manual.providerId, model: manual.model, count: input.count, minutes: input.minutes });
      return manual;
    },

    stopManual(actor: CaptureActor, client: CaptureClientInfo): void {
      const m = activeManual();
      manual = null;
      if (m) record('CAPTURE_STOPPED', actor, client, { captured: m.total - m.remaining, of: m.total });
    },

    delete(actor: CaptureActor, ids: string[] | 'all', client: CaptureClientInfo): number {
      const n = ids === 'all' ? repo.deleteAll() : repo.delete(ids);
      if (n) record('CAPTURES_DELETED', actor, client, { count: n, all: ids === 'all' });
      return n;
    },

    /** The file to hand to a developer. Audited, with whether the text was masked. */
    export(actor: CaptureActor, ids: string[], maskText: boolean, client: CaptureClientInfo): CaptureExportFile {
      const unique = [...new Set(ids)];
      if (!unique.length) throw errors.validation([{ path: 'ids', message: 'choose at least one capture' }]);
      if (unique.length > CAPTURE_EXPORT_MAX) throw errors.validation([{ path: 'ids', message: `at most ${CAPTURE_EXPORT_MAX} captures per export` }]);
      const found = repo.existing(unique);
      if (found.length !== unique.length) throw errors.notFound('Capture not found.');
      const captures = found.map((id) => repo.get(id)!).map((c) => (maskText ? maskCapture(c) : c));
      record('CAPTURES_EXPORTED', actor, client, { ids: found, masked: maskText });
      return { format: 'clawrouter-capture', version: 1, clawrouterVersion: options.version, exportedAt: now().toISOString(), masked: maskText, captures };
    },
  };
}

/** Limits for POST /api/captures/manual, checked by the controller. */
export const MANUAL_LIMITS = { maxCount: MANUAL_CAPTURE_MAX_COUNT, maxMinutes: MANUAL_CAPTURE_MAX_MINUTES };
