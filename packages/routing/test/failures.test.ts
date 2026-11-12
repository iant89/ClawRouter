import { describe, expect, test } from 'bun:test';
import { FailureTracker } from '../src/index.ts';

describe('FailureTracker', () => {
  test('counts failures inside the window; success clears them', () => {
    let t = 0;
    const f = new FailureTracker(1000, () => t);
    f.recordFailure('p');
    t = 500;
    f.recordFailure('p');
    expect(f.count('p')).toBe(2);
    t = 1200; // the first one expired
    expect(f.count('p')).toBe(1);
    f.recordSuccess('p');
    expect(f.count('p')).toBe(0);
    expect(f.count('other')).toBe(0);
  });
});
