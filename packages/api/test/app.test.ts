import { describe, expect, test } from 'bun:test';
import { createLogger, type LogRecord } from '@clawapi/core';
import { createHealthService, type HealthCheck } from '@clawapi/health';
import { REQUEST_ID_HEADER, type ApiErrorBody, type ApiSuccess, type HealthReport } from '@clawapi/shared';
import { createApiApp } from '../src/index.ts';

function setup(checks: HealthCheck[] = [{ component: 'database', critical: true, check: () => ({ status: 'HEALTHY' }) }]) {
  const records: LogRecord[] = [];
  const log = createLogger({ level: 'debug', sink: (r) => records.push(r) });
  const health = createHealthService({ checks, version: '9.9.9', environment: 'test' });
  return { app: createApiApp({ log, health }), records };
}

const get = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe('GET /api/health', () => {
  test('returns the report in the success envelope', async () => {
    const res = await setup().app.handle(get('/api/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as ApiSuccess<HealthReport>;
    expect(body.data.status).toBe('HEALTHY');
    expect(body.data.version).toBe('9.9.9');
  });

  test('returns 503 when a critical component is offline', async () => {
    const { app } = setup([{ component: 'database', critical: true, check: () => ({ status: 'OFFLINE' }) }]);
    const res = await app.handle(get('/api/health'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiSuccess<HealthReport>).data.status).toBe('OFFLINE');
  });

  test('HEAD has no body', async () => {
    const res = await setup().app.handle(get('/api/health', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('conventions', () => {
  test('every response carries a request id and security headers', async () => {
    const res = await setup().app.handle(get('/api/health'));
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/^req_[0-9a-f]{32}$/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('unknown routes return a normalized 404', async () => {
    const res = await setup().app.handle(get('/api/unknown'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers.get(REQUEST_ID_HEADER)!);
  });

  test('the external gateway namespace is separate and not yet served', async () => {
    const res = await setup().app.handle(get('/v1/chat/completions', { method: 'POST' }));
    expect(res.status).toBe(404);
  });

  test('wrong method returns 405 with Allow', async () => {
    const res = await setup().app.handle(get('/api/health', { method: 'DELETE' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(((await res.json()) as ApiErrorBody).error.code).toBe('METHOD_NOT_ALLOWED');
  });

  test('internal errors are logged but never leak to the client', async () => {
    const { app, records } = setup();
    app.router.get('/api/explode', () => { throw new Error('secret internal detail: password=hunter2'); });
    const res = await app.handle(get('/api/explode'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret internal detail');
    expect(text).not.toContain('stack');
    expect((JSON.parse(text) as ApiErrorBody).error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An internal error occurred.' });
    expect(records.some((r) => r.msg === 'request failed' && r.level === 'error')).toBe(true);
  });

  test('access log never includes query strings', async () => {
    const { app, records } = setup();
    await app.handle(get('/api/health?token=abc'));
    const line = JSON.stringify(records.find((r) => r.msg === 'http request'));
    expect(line).toContain('/api/health');
    expect(line).not.toContain('abc');
  });
});
