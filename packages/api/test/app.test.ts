import { describe, expect, test } from 'bun:test';
import { REQUEST_ID_HEADER, type ApiErrorBody, type ApiSuccess, type HealthReport } from '@clawapi/shared';
import { createHarness } from '../../../tests/support/harness.ts';

describe('GET /api/health', () => {
  test('is public and returns the report in the success envelope', async () => {
    const res = await createHarness().request('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as ApiSuccess<HealthReport>;
    expect(body.data.status).toBe('HEALTHY');
  });

  test('returns 503 when a critical component is offline', async () => {
    const h = createHarness();
    h.db.close();
    const res = await h.request('/api/health');
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiSuccess<HealthReport>).data.status).toBe('OFFLINE');
  });

  test('HEAD has no body', async () => {
    const res = await createHarness().request('/api/health', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('conventions', () => {
  test('every response carries a request id and security headers', async () => {
    const res = await createHarness().request('/api/health');
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/^req_[0-9a-f]{32}$/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('unknown routes return a normalized 404', async () => {
    const res = await createHarness().request('/api/unknown');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers.get(REQUEST_ID_HEADER)!);
  });

  test('the external gateway namespace is separate and not yet served', async () => {
    const res = await createHarness().request('/v1/chat/completions', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('wrong method returns 405 with Allow', async () => {
    const res = await createHarness().request('/api/health', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(((await res.json()) as ApiErrorBody).error.code).toBe('METHOD_NOT_ALLOWED');
  });

  test('internal errors are logged but never leak to the client', async () => {
    const h = createHarness();
    h.api.router.get('/api/explode', 'public', () => { throw new Error('secret internal detail: password=hunter2'); });
    const res = await h.request('/api/explode');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret internal detail');
    expect(text).not.toContain('stack');
    expect((JSON.parse(text) as ApiErrorBody).error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An internal error occurred.' });
    expect(h.logs.some((r) => r.msg === 'request failed' && r.level === 'error')).toBe(true);
  });

  test('access log never includes query strings', async () => {
    const h = createHarness();
    await h.request('/api/health?token=abc');
    const line = JSON.stringify(h.logs.find((r) => r.msg === 'http request'));
    expect(line).toContain('/api/health');
    expect(line).not.toContain('abc');
  });
});
