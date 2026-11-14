import { describe, expect, test } from 'bun:test';
import { RollingSum } from '../src/index.ts';

describe('RollingSum', () => {
  test('sums the last window, to the bucket', () => {
    const r = new RollingSum(1_000, 60); // the last minute in seconds
    const t0 = Date.parse('2026-11-14T00:00:00.000Z');
    r.add(t0);
    r.add(t0 + 500, 2);
    r.add(t0 + 30_000);
    expect(r.sum(t0 + 30_000)).toBe(4);
    expect(r.sum(t0 + 59_999)).toBe(4);
    expect(r.sum(t0 + 60_000)).toBe(1); // the first second's bucket has left the window
    expect(r.sum(t0 + 90_000)).toBe(0);
  });

  test('reused slots start again from zero; memory stays fixed', () => {
    const r = new RollingSum(1_000, 3);
    for (let s = 0; s < 10_000; s++) r.add(s * 1_000, 5);
    expect(r.sum(9_999_000)).toBe(15);
    // A query for an earlier time ignores buckets from its future.
    expect(r.sum(9_997_000)).toBe(5);
  });
});
