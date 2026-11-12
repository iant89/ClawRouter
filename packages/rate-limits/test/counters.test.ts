import { describe, expect, test } from 'bun:test';
import { DEFAULT_RATE_LIMITS } from '@clawrouter/shared';
import { MemoryCounterStore } from '../src/counters.ts';
import { validateRateLimits } from '../src/config.ts';

const W = 60_000;
function store(start = 1_800_000_000_000 - (1_800_000_000_000 % W)) {
  const clock = { t: start };
  return { clock, s: new MemoryCounterStore(() => clock.t) };
}

describe('MemoryCounterStore (sliding window)', () => {
  test('allows up to the limit, then refuses with a retry time', async () => {
    const { s } = store();
    for (let i = 0; i < 3; i++) expect((await s.consume('k', 1, 3, W)).allowed).toBe(true);
    const refused = await s.consume('k', 1, 3, W);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(2 * W);
    expect((await s.peek('k', W)).used).toBe(3);
  });

  test('a burst at the end of one window still counts at the start of the next (no doubling)', async () => {
    const { s, clock } = store();
    clock.t += 59_000;
    for (let i = 0; i < 10; i++) await s.consume('k', 1, 10, W);
    clock.t += 2_000; // 1 s into the next window: ~98% of the previous window still counts
    expect((await s.consume('k', 1, 10, W)).allowed).toBe(false);
    clock.t += 30_000; // half way: about 5 still count
    const half = await s.peek('k', W);
    expect(half.used).toBeGreaterThan(4);
    expect(half.used).toBeLessThan(6);
    expect((await s.consume('k', 1, 10, W)).allowed).toBe(true);
  });

  test('the retry time is honest: waiting that long is enough', async () => {
    const { s, clock } = store();
    clock.t += 20_000;
    for (let i = 0; i < 5; i++) await s.consume('k', 1, 5, W);
    const refused = await s.consume('k', 1, 5, W);
    clock.t += refused.retryAfterMs;
    expect((await s.consume('k', 1, 5, W)).allowed).toBe(true);
  });

  test('counters reset after two idle windows', async () => {
    const { s, clock } = store();
    await s.consume('k', 5, null, W);
    clock.t += 2 * W + 1;
    expect((await s.peek('k', W)).used).toBe(0);
  });

  test('add charges unconditionally (tokens after a request)', async () => {
    const { s } = store();
    await s.add('t', 500, W);
    await s.add('t', 0, W);
    expect((await s.peek('t', W)).used).toBe(500);
    expect((await s.peek('t', W, 1, 400)).retryAfterMs).toBeGreaterThan(0);
  });

  test('concurrency slots', async () => {
    const { s } = store();
    expect(await s.acquire('c', 2)).toBe(true);
    expect(await s.acquire('c', 2)).toBe(true);
    expect(await s.acquire('c', 2)).toBe(false);
    await s.release('c');
    expect(await s.inFlight('c')).toBe(1);
    expect(await s.acquire('c', null)).toBe(true);
  });

  test('memory stays bounded', async () => {
    const clock = { t: 0 };
    const s = new MemoryCounterStore(() => clock.t, 100);
    for (let i = 0; i < 1000; i++) await s.consume(`k${i}`, 1, null, W);
    expect(s.size).toBeLessThanOrEqual(100);
  });

  test('keys lists live counters by prefix', async () => {
    const { s } = store();
    await s.consume('req:key:a', 1, null, W);
    await s.consume('tok:key:a', 1, null, W);
    expect(await s.keys('req:')).toEqual(['req:key:a']);
  });
});

describe('validateRateLimits', () => {
  test('the defaults are valid', () => {
    expect(validateRateLimits(structuredClone(DEFAULT_RATE_LIMITS))).toEqual([]);
  });

  test('reports bad values with their path', () => {
    const s = structuredClone(DEFAULT_RATE_LIMITS);
    s.perKey.requestsPerMinute = 0;
    s.global.maxConcurrent = 1.5;
    s.invalidKeysPerIp = 0;
    s.perModel = [
      { model: 'no-slash', requestsPerMinute: 1, tokensPerMinute: null },
      { model: 'a/b', requestsPerMinute: null, tokensPerMinute: null },
      { model: 'A/B', requestsPerMinute: 5, tokensPerMinute: null },
    ];
    expect(validateRateLimits(s).map((i) => i.path)).toEqual([
      'perKey.requestsPerMinute', 'global.maxConcurrent', 'invalidKeysPerIp', 'perModel[0].model', 'perModel[1]', 'perModel[2].model',
    ]);
  });
});
