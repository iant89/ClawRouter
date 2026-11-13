import { AppError, errors, newId, type EventBus, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import {
  FINAL_OPERATION_STATUSES, OPERATION_TYPES, type OperationInfo, type OperationQuery, type OperationStatus, type OperationType,
} from '@clawrouter/shared';
import type { OperationRepository } from './repository.ts';

/** Who starts, sees or cancels operations. */
export interface OperationActor {
  id: string;
  username: string;
  permissions: ReadonlySet<string>;
}

export interface OperationContext {
  /** Aborted on cancellation or timeout: stop as soon as practical. */
  signal: AbortSignal;
  /** Reports progress (0–100) and what is happening; updates are rate-limited. */
  progress(percent: number, message?: string): void;
  /** Address and request of whoever started the operation, for audit records written by the work. */
  client: { ip: string | null; requestId?: string | null };
  /** The user who started the operation. */
  actor: OperationActor;
  targetId: string | null;
}

/** The work behind an operation type, registered by the composition root. */
export interface OperationHandler {
  timeoutMs: number;
  /** Throws a NOT_FOUND / VALIDATION_ERROR AppError for a bad target, before anything is queued. */
  validateTarget?(targetId: string): void;
  /** Display name of a target (e.g. the provider's name). */
  describeTarget?(targetId: string): string | null;
  /** Does the work. Returns the result (no secrets) and a closing message; throws to fail. */
  run(ctx: OperationContext): Promise<{ result: unknown; message: string; ok?: boolean }>;
}

const PROGRESS_INTERVAL_MS = 250;

export type OperationService = ReturnType<typeof createOperationService>;

/**
 * Long-running operations (spec §26): QUEUED → RUNNING → SUCCESS / FAILED /
 * TIMEOUT / CANCELLED. A small queue runs `maxConcurrent` at a time; starting the
 * same type and target while one is pending returns the pending one. Every change
 * is stored and emitted as `operation.progress`.
 */
export function createOperationService(options: {
  repo: OperationRepository;
  handlers: Partial<Record<OperationType, OperationHandler>>;
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
  maxConcurrent?: number;
  retentionDays?: number;
}) {
  const { repo, handlers, audit, events, log } = options;
  const now = options.now ?? (() => new Date());
  const maxConcurrent = options.maxConcurrent ?? 2;
  const queue: string[] = [];
  const running = new Map<string, AbortController>();
  const pending = new Map<string, { type: OperationType; targetId: string | null; actor: OperationActor; client: { ip: string | null; requestId?: string | null } }>();
  const waiters = new Map<string, ((op: OperationInfo) => void)[]>();
  let stopped = false;

  const handlerFor = (type: OperationType) => {
    const h = handlers[type];
    if (!h) throw new AppError('VALIDATION_ERROR', `Operations of type ${type} are not available.`);
    return h;
  };

  function info(id: string): OperationInfo | undefined {
    const op = repo.get(id);
    if (!op) return undefined;
    const label = op.targetId ? handlers[op.type]?.describeTarget?.(op.targetId) ?? null : null;
    return { ...op, targetLabel: label };
  }

  function change(id: string, type: OperationType, targetId: string | null, patch: Parameters<OperationRepository['update']>[1]) {
    if (stopped) return;
    repo.update(id, patch);
    const op = repo.get(id);
    if (!op) return;
    events?.emit('operation.progress', { id, type, targetId, status: op.status, progress: op.progress, message: op.message });
    if ((FINAL_OPERATION_STATUSES as readonly string[]).includes(op.status)) {
      const done = info(id)!;
      for (const resolve of waiters.get(id) ?? []) resolve(done);
      waiters.delete(id);
    }
  }

  function pump() {
    while (running.size < maxConcurrent && queue.length) {
      const id = queue.shift()!;
      const job = pending.get(id);
      if (job) void execute(id, job);
    }
  }

  async function execute(id: string, job: { type: OperationType; targetId: string | null; actor: OperationActor; client: { ip: string | null; requestId?: string | null } }) {
    const handler = handlerFor(job.type);
    const controller = new AbortController();
    running.set(id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, handler.timeoutMs);
    let lastProgress = 0;
    change(id, job.type, job.targetId, { status: 'RUNNING', startedAt: now().toISOString(), progress: 0, message: 'Started' });
    try {
      const outcome = await Promise.race([
        handler.run({
          signal: controller.signal, actor: job.actor, targetId: job.targetId, client: job.client,
          progress(percent, message) {
            if (controller.signal.aborted) return;
            const t = Date.now();
            if (t - lastProgress < PROGRESS_INTERVAL_MS && percent < 100) return;
            lastProgress = t;
            change(id, job.type, job.targetId, { progress: Math.max(0, Math.min(100, Math.round(percent))), ...(message !== undefined ? { message } : {}) });
          },
        }),
        // Cancellation and timeouts end the operation even if the work ignores the signal.
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
      ]);
      change(id, job.type, job.targetId, {
        status: outcome.ok === false ? 'FAILED' : 'SUCCESS', progress: 100, message: outcome.message, result: outcome.result,
        error: outcome.ok === false ? outcome.message : null, completedAt: now().toISOString(),
      });
    } catch (error) {
      const at = now().toISOString();
      if (timedOut) change(id, job.type, job.targetId, { status: 'TIMEOUT', error: `Did not finish within ${Math.round(handler.timeoutMs / 1000)} s.`, message: 'Timed out', completedAt: at });
      else if (controller.signal.aborted) change(id, job.type, job.targetId, { status: 'CANCELLED', message: 'Cancelled', completedAt: at });
      else {
        const message = error instanceof AppError && error.expose ? error.message : 'The operation failed.';
        if (!(error instanceof AppError && error.expose)) log?.error('operation failed', { component: 'operations', type: job.type, id, error });
        change(id, job.type, job.targetId, { status: 'FAILED', error: message, message: 'Failed', completedAt: at });
      }
    } finally {
      clearTimeout(timer);
      running.delete(id);
      pending.delete(id);
      pump();
    }
  }

  const canView = (actor: Pick<OperationActor, 'permissions'>, type: OperationType) => actor.permissions.has(OPERATION_TYPES[type].view);
  const canRun = (actor: Pick<OperationActor, 'permissions'>, type: OperationType) => actor.permissions.has(OPERATION_TYPES[type].run);

  const service = {
    /** Queues an operation (or returns the same type and target already pending). */
    start(actor: OperationActor, input: { type: OperationType; targetId?: string | null }, client: { ip: string | null; requestId?: string | null }): OperationInfo {
      const def = OPERATION_TYPES[input.type];
      if (!canRun(actor, input.type)) throw new AppError('AUTHORIZATION_ERROR');
      const handler = handlerFor(input.type);
      const targetId = def.target ? input.targetId ?? null : null;
      if (def.target && !targetId) throw errors.validation([{ path: 'targetId', message: 'is required for this operation' }]);
      if (targetId) handler.validateTarget?.(targetId);
      for (const [id, job] of pending) {
        if (job.type === input.type && job.targetId === targetId) return info(id)!;
      }
      const id = newId();
      repo.insert({
        id, type: input.type, targetId, status: 'QUEUED', progress: 0, message: 'Waiting to start', result: null, error: null,
        createdBy: actor.id, createdAt: now().toISOString(), startedAt: null, completedAt: null,
      });
      audit.record({
        action: 'OPERATION_STARTED', result: 'SUCCESS', resource: 'operation', resourceId: id,
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
        metadata: { type: input.type, targetId },
      });
      events?.emit('operation.progress', { id, type: input.type, targetId, status: 'QUEUED', progress: 0, message: 'Waiting to start' });
      pending.set(id, { type: input.type, targetId, actor, client });
      queue.push(id);
      pump();
      return info(id)!;
    },

    /** Starts (or joins) an operation and waits for it to end. */
    async run(actor: OperationActor, input: { type: OperationType; targetId?: string | null }, client: { ip: string | null; requestId?: string | null }): Promise<OperationInfo> {
      const op = service.start(actor, input, client);
      if ((FINAL_OPERATION_STATUSES as readonly string[]).includes(op.status)) return op;
      return new Promise((resolve) => waiters.set(op.id, [...(waiters.get(op.id) ?? []), resolve]));
    },

    /** Cancels a queued or running operation. Running work is told to stop; the operation ends as CANCELLED at once. */
    cancel(actor: OperationActor, id: string, client: { ip: string | null; requestId?: string | null }): OperationInfo {
      const op = repo.get(id);
      if (!op || !canView(actor, op.type)) throw errors.notFound('Operation not found.');
      if (!canRun(actor, op.type)) throw new AppError('AUTHORIZATION_ERROR');
      if ((FINAL_OPERATION_STATUSES as readonly string[]).includes(op.status)) {
        throw errors.conflict(`The operation has already ended (${op.status.toLowerCase()}).`);
      }
      audit.record({
        action: 'OPERATION_CANCELLED', result: 'SUCCESS', resource: 'operation', resourceId: id,
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
        metadata: { type: op.type, targetId: op.targetId, status: op.status },
      });
      const controller = running.get(id);
      if (controller) controller.abort();
      else {
        const index = queue.indexOf(id);
        if (index >= 0) queue.splice(index, 1);
        pending.delete(id);
        change(id, op.type, op.targetId, { status: 'CANCELLED', message: 'Cancelled before it started', completedAt: now().toISOString() });
      }
      return info(id)!;
    },

    get(actor: Pick<OperationActor, 'permissions'>, id: string): OperationInfo {
      const op = info(id);
      if (!op || !canView(actor, op.type)) throw errors.notFound('Operation not found.');
      return op;
    },

    /** Only the types the user may see. */
    list(actor: Pick<OperationActor, 'permissions'>, q: OperationQuery = {}): { items: OperationInfo[]; total: number; page: number; pageSize: number } {
      const page = q.page ?? 1;
      const pageSize = q.pageSize ?? 50;
      const types = (Object.keys(OPERATION_TYPES) as OperationType[]).filter((t) => canView(actor, t) && (!q.type || q.type === t));
      const { items, total } = repo.list({ types, status: q.status, limit: pageSize, offset: (page - 1) * pageSize });
      return { items: items.map((o) => ({ ...o, targetLabel: o.targetId ? handlers[o.type]?.describeTarget?.(o.targetId) ?? null : null })), total, page, pageSize };
    },

    /** At startup: operations a previous process left unfinished. */
    recoverInterrupted(): number {
      const n = repo.markInterrupted(now().toISOString());
      if (n) log?.warn('operations interrupted by a restart marked as failed', { component: 'operations', count: n });
      return n;
    },

    prune(): number {
      const days = options.retentionDays ?? 30;
      return days > 0 ? repo.prune(new Date(now().getTime() - days * 86_400_000).toISOString()) : 0;
    },

    /** Stops running work (server shutdown). */
    stop() {
      stopped = true;
      for (const c of running.values()) c.abort();
      queue.length = 0;
    },

    get activeCount() {
      return pending.size;
    },
  };
  return service;
}

export type { OperationStatus };
