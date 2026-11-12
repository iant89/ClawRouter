import { describe, expect, test } from 'bun:test';
import { FailureThrottle } from '../src/index.ts';

describe('FailureThrottle', () => {
  const make = (t: { now: number }) => new FailureThrottle({ limit: 3, windowMs: 1000, blockMs: 5000, now: () => t.now });

  test('blocks after `limit` failures within the window', () => {
    const t = { now: 0 };
    const th = make(t);
    th.fail('k');
    th.fail('k');
    expect(th.retryAfter('k')).toBe(0);
    th.fail('k');
    expect(th.retryAfter('k')).toBe(5000);
    t.now = 4000;
    expect(th.retryAfter('k')).toBe(1000);
    t.now = 5000;
    expect(th.retryAfter('k')).toBe(0);
  });

  test('failures outside the window do not count', () => {
    const t = { now: 0 };
    const th = make(t);
    th.fail('k');
    th.fail('k');
    t.now = 1500;
    th.fail('k');
    expect(th.retryAfter('k')).toBe(0);
  });

  test('reset clears a key; keys are independent', () => {
    const t = { now: 0 };
    const th = make(t);
    for (let i = 0; i < 3; i++) th.fail('a');
    expect(th.retryAfter('b')).toBe(0);
    th.reset('a');
    expect(th.retryAfter('a')).toBe(0);
  });

  test('memory is bounded', () => {
    const t = { now: 0 };
    const th = new FailureThrottle({ limit: 3, windowMs: 1000, blockMs: 1000, maxKeys: 100, now: () => t.now });
    for (let i = 0; i < 1000; i++) th.fail(`k${i}`);
    expect(th.size).toBeLessThanOrEqual(100);
  });
});
