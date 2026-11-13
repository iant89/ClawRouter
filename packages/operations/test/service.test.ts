import { describe, expect, test } from 'bun:test';
import { AppError } from '@clawrouter/core';
import { createOperationService, createSqliteOperationRepository, type OperationHandler } from '../src/index.ts';
import { createHarness } from '../../../tests/support/harness.ts';

const ADMIN = { id: 'admin-id', username: 'admin', permissions: new Set(['health.read', 'providers.read', 'providers.write']) };
const VIEWER = { id: 'viewer-id', username: 'viewer', permissions: new Set(['health.read', 'providers.read']) };
const NOBODY = { id: 'nobody-id', username: 'nobody', permissions: new Set<string>() };
const client = { ip: null };

/** A handler whose run waits until the test releases it (or ignores cancellation, if asked). */
function controllable(options: { ignoreSignal?: boolean; timeoutMs?: number } = {}) {
  const releases: (() => void)[] = [];
  let runs = 0;
  const handler: OperationHandler = {
    timeoutMs: options.timeoutMs ?? 10_000,
    validateTarget: (id) => {
      if (id === 'missing') throw new AppError('NOT_FOUND', 'Provider not found.');
    },
    describeTarget: (id) => `Provider ${id}`,
    run: (ctx) => {
      runs += 1;
      ctx.progress(50, 'Half way');
      return new Promise((resolve, reject) => {
        releases.push(() => resolve({ result: { done: true }, message: 'Finished' }));
        if (!options.ignoreSignal) ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
  return { handler, release: () => releases.shift()?.(), runs: () => runs };
}

const tick = () => Bun.sleep(5);

function setup(handlers: Parameters<typeof createOperationService>[0]['handlers'], maxConcurrent = 2) {
  const h = createHarness();
  const progress: string[] = [];
  h.events.on('operation.progress', (e) => { progress.push(`${e.status}:${e.progress}`); });
  const ops = createOperationService({ repo: createSqliteOperationRepository(h.db), handlers, audit: h.audit, events: h.events, now: h.clock.now, maxConcurrent });
  return { h, ops, progress };
}

describe('lifecycle', () => {
  test('QUEUED → RUNNING → SUCCESS with progress, result and audit', async () => {
    const c = controllable();
    const { h, ops, progress } = setup({ 'health.check': c.handler });
    const op = ops.start(ADMIN, { type: 'health.check' }, client);
    expect(op.status).toBe('RUNNING'); // a free slot: it starts at once
    c.release();
    await tick();
    expect(ops.get(ADMIN, op.id)).toMatchObject({ status: 'SUCCESS', progress: 100, message: 'Finished', result: { done: true } });
    expect(progress).toEqual(['QUEUED:0', 'RUNNING:0', 'RUNNING:50', 'SUCCESS:100']);
    expect(h.audit.list({ action: 'OPERATION_STARTED' })).toHaveLength(1);
  });

  test('a queue runs only maxConcurrent at a time; the same target joins the pending operation', async () => {
    const c = controllable();
    const { ops } = setup({ 'provider.test': c.handler }, 1);
    const a = ops.start(ADMIN, { type: 'provider.test', targetId: 'p1' }, client);
    const b = ops.start(ADMIN, { type: 'provider.test', targetId: 'p2' }, client);
    expect(ops.start(ADMIN, { type: 'provider.test', targetId: 'p2' }, client).id).toBe(b.id);
    expect(ops.get(ADMIN, b.id)).toMatchObject({ status: 'QUEUED', targetLabel: 'Provider p2' });
    c.release();
    await tick();
    expect(ops.get(ADMIN, a.id).status).toBe('SUCCESS');
    expect(ops.get(ADMIN, b.id).status).toBe('RUNNING');
    c.release();
    await tick();
    expect(c.runs()).toBe(2);
  });

  test('a target is required and validated before anything is queued', () => {
    const { ops } = setup({ 'provider.test': controllable().handler });
    const missing = (() => { try { ops.start(ADMIN, { type: 'provider.test' }, client); } catch (e) { return e as AppError; } })();
    expect(missing?.details?.issues).toEqual([{ path: 'targetId', message: 'is required for this operation' }]);
    expect(() => ops.start(ADMIN, { type: 'provider.test', targetId: 'missing' }, client)).toThrow('Provider not found.');
    expect(ops.list(ADMIN).total).toBe(0);
  });
});

describe('ending early', () => {
  test('cancelling a running operation ends it at once, even if the work ignores the signal', async () => {
    const c = controllable({ ignoreSignal: true });
    const { h, ops } = setup({ 'health.check': c.handler });
    const op = ops.start(ADMIN, { type: 'health.check' }, client);
    ops.cancel(ADMIN, op.id, client);
    await tick();
    expect(ops.get(ADMIN, op.id)).toMatchObject({ status: 'CANCELLED', message: 'Cancelled' });
    c.release(); // the late result is ignored
    await tick();
    expect(ops.get(ADMIN, op.id).status).toBe('CANCELLED');
    expect(h.audit.list({ action: 'OPERATION_CANCELLED' })).toHaveLength(1);
    expect(() => ops.cancel(ADMIN, op.id, client)).toThrow(/already ended/);
  });

  test('a queued operation can be cancelled before it runs', async () => {
    const c = controllable();
    const { ops } = setup({ 'provider.test': c.handler }, 1);
    ops.start(ADMIN, { type: 'provider.test', targetId: 'p1' }, client);
    const queued = ops.start(ADMIN, { type: 'provider.test', targetId: 'p2' }, client);
    expect(ops.cancel(ADMIN, queued.id, client).status).toBe('CANCELLED');
    c.release();
    await tick();
    expect(c.runs()).toBe(1);
  });

  test('timeouts end as TIMEOUT', async () => {
    const c = controllable({ timeoutMs: 20 });
    const { ops } = setup({ 'health.check': c.handler });
    const op = ops.start(ADMIN, { type: 'health.check' }, client);
    await Bun.sleep(60);
    expect(ops.get(ADMIN, op.id)).toMatchObject({ status: 'TIMEOUT', error: expect.stringContaining('Did not finish') });
  });

  test('failures keep internal errors private', async () => {
    const { ops } = setup({
      'health.check': { timeoutMs: 1000, run: async () => { throw new Error('ECONNREFUSED 10.0.0.5:5432 password=hunter2'); } },
      'providers.check': { timeoutMs: 1000, run: async () => { throw new AppError('VALIDATION_ERROR', 'No providers are enabled.'); } },
    });
    const a = ops.start(ADMIN, { type: 'health.check' }, client);
    const b = ops.start(ADMIN, { type: 'providers.check' }, client);
    await tick();
    expect(ops.get(ADMIN, a.id)).toMatchObject({ status: 'FAILED', error: 'The operation failed.' });
    expect(ops.get(ADMIN, b.id)).toMatchObject({ status: 'FAILED', error: 'No providers are enabled.' });
  });

  test('operations left by a stopped server are marked failed at startup', () => {
    const c = controllable();
    const { h, ops } = setup({ 'health.check': c.handler });
    const op = ops.start(ADMIN, { type: 'health.check' }, client);
    const restarted = createOperationService({ repo: createSqliteOperationRepository(h.db), handlers: {}, audit: h.audit });
    expect(restarted.recoverInterrupted()).toBe(1);
    expect(ops.get(ADMIN, op.id)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('server stopped') });
  });
});

describe('permissions per operation type', () => {
  test('viewers see but cannot start or cancel provider operations; users without roles see nothing', async () => {
    const c = controllable();
    const { ops } = setup({ 'provider.test': c.handler, 'health.check': controllable().handler });
    const op = ops.start(ADMIN, { type: 'provider.test', targetId: 'p1' }, client);
    expect(() => ops.start(VIEWER, { type: 'provider.test', targetId: 'p1' }, client)).toThrow(AppError);
    expect(() => ops.cancel(VIEWER, op.id, client)).toThrow(AppError);
    expect(ops.list(VIEWER).total).toBe(1);
    expect(ops.start(VIEWER, { type: 'health.check' }, client).status).toBe('RUNNING');
    expect(ops.list(NOBODY).total).toBe(0);
    expect(() => ops.get(NOBODY, op.id)).toThrow('Operation not found.');
  });

  test('run() waits for the end', async () => {
    const { ops } = setup({ 'health.check': { timeoutMs: 1000, run: async (ctx) => { ctx.progress(100); return { result: 1, message: 'ok' }; } } });
    expect(await ops.run(ADMIN, { type: 'health.check' }, client)).toMatchObject({ status: 'SUCCESS', result: 1 });
  });
});
