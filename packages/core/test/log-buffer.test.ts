import { describe, expect, test } from 'bun:test';
import { createLogger, LogBuffer, redact, scrubSecrets } from '../src/index.ts';

describe('scrubSecrets', () => {
  test('removes secret-shaped strings but keeps what helps an investigator', () => {
    const crk = `crk_0a1b2c3d_${'A'.repeat(43)}`;
    expect(scrubSecrets(`key ${crk} rejected`)).toBe('key crk_0a1b2c3d_[REDACTED] rejected');
    expect(scrubSecrets('Incorrect API key provided: sk-proj-abcdefghijklmnop1234')).toBe('Incorrect API key provided: sk-[REDACTED]');
    expect(scrubSecrets('x-goog-api-key AIzaSyA1234567890abcdefghijklmnopqrstuv')).toBe('x-goog-api-key AIza[REDACTED]');
    expect(scrubSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload')).toBe('Authorization: Bearer [REDACTED]');
    expect(scrubSecrets('nothing secret here, sk-short')).toBe('nothing secret here, sk-short');
  });

  test('redact scrubs strings inside values, errors and log messages', () => {
    const err = new Error('upstream said: invalid key sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ');
    expect(JSON.stringify(redact({ detail: 'Bearer abcdefghijklmnop', error: err }))).not.toMatch(/abcdefghijklmnop|ZZZZ/);
    const records: string[] = [];
    createLogger({ sink: (_, line) => records.push(line) }).info('client sent Bearer abcdefghijklmnop');
    expect(records[0]).toContain('Bearer [REDACTED]');
  });
});

describe('LogBuffer', () => {
  const fill = (n: number, capacity = 10) => {
    const buffer = new LogBuffer(capacity);
    const log = createLogger({ level: 'debug', sink: () => {}, tap: buffer.push });
    for (let i = 1; i <= n; i++) {
      const level = i % 5 === 0 ? 'error' : 'info';
      log[level](`message ${i}`, { component: i % 2 ? 'gateway' : 'auth', requestId: `req_${i}`, extra: { n: i } });
    }
    return buffer;
  };

  test('keeps the newest records, newest first', () => {
    const page = fill(25).query();
    expect(page.items.map((e) => e.msg)).toEqual(Array.from({ length: 10 }, (_, i) => `message ${25 - i}`));
    expect(page).toMatchObject({ latestSeq: 25, capacity: 10, hasOlder: false, components: ['auth', 'gateway'] });
  });

  test('filters by level, component, request id and text', () => {
    const b = fill(10);
    expect(b.query({ level: 'error' }).items.map((e) => e.msg)).toEqual(['message 10', 'message 5']);
    expect(b.query({ component: 'auth' }).items).toHaveLength(5);
    expect(b.query({ requestId: 'req_7' }).items.map((e) => e.msg)).toEqual(['message 7']);
    expect(b.query({ q: '"n":3' }).items.map((e) => e.msg)).toEqual(['message 3']);
    expect(b.query({ q: 'MESSAGE 9' }).items.map((e) => e.msg)).toEqual(['message 9']);
  });

  test('pages with before (older) and after (follow)', () => {
    const b = fill(10);
    const first = b.query({ limit: 4 });
    expect(first.items.map((e) => e.seq)).toEqual([10, 9, 8, 7]);
    expect(first.hasOlder).toBe(true);
    expect(b.query({ limit: 4, before: 7 }).items.map((e) => e.seq)).toEqual([6, 5, 4, 3]);
    expect(b.query({ after: 8 }).items.map((e) => e.seq)).toEqual([10, 9]);
  });

  test('very large fields are not kept', () => {
    const buffer = new LogBuffer(5);
    createLogger({ sink: () => {}, tap: buffer.push }).info('big', { blob: 'x'.repeat(20_000) });
    expect(buffer.query().items[0]!.fields).toEqual({ note: 'Fields larger than 16 KB were not kept.' });
  });
});
