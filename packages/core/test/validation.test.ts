import { describe, expect, test } from 'bun:test';
import { AppError, parse, v } from '../src/index.ts';

const schema = v.object({
  name: v.string({ min: 2, max: 5 }),
  secret: v.string({ trim: false, min: 1 }),
  tag: v.optional(v.string({ pattern: /^[a-z]+$/ })),
  on: v.optional(v.boolean()),
});

function issues(value: unknown) {
  try {
    parse(schema, value);
  } catch (error) {
    return (error as AppError).details?.issues ?? [];
  }
  return [];
}

describe('validation', () => {
  test('returns typed, trimmed values', () => {
    expect(parse(schema, { name: '  ab ', secret: ' x ', on: true })).toEqual({ name: 'ab', secret: ' x ', tag: undefined, on: true });
  });

  test('reports every problem with its path', () => {
    expect(issues({ name: 'a', tag: 'A1', extra: 1 })).toEqual([
      { path: 'extra', message: 'is not allowed' },
      { path: 'name', message: 'must be at least 2 characters' },
      { path: 'secret', message: 'is required' },
      { path: 'tag', message: 'has an invalid format' },
    ]);
  });

  test('rejects non-objects', () => {
    expect(issues([])).toEqual([{ path: '(body)', message: 'must be an object' }]);
    expect(issues(null)).toEqual([{ path: '(body)', message: 'must be an object' }]);
  });

  test('throws VALIDATION_ERROR', () => {
    expect(() => parse(schema, {})).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});
