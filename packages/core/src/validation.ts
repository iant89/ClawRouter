import type { FieldIssue } from '@clawapi/shared';
import { errors } from './errors.ts';

/**
 * Minimal runtime validation for external input (request bodies, query
 * strings). Deliberately small: enough for typed, safe parsing with field-level
 * issues. Swap for a library only if needs outgrow it.
 */
export type Validator<T> = (value: unknown, path: string, issues: FieldIssue[]) => T | undefined;
export type Infer<V> = V extends Validator<infer T> ? T : never;

export interface StringRules {
  min?: number;
  max?: number;
  pattern?: RegExp;
  patternMessage?: string;
  /** Trim surrounding whitespace before checking. @default true */
  trim?: boolean;
}

export const v = {
  string(rules: StringRules = {}): Validator<string> {
    return (value, path, issues) => {
      if (typeof value !== 'string') {
        issues.push({ path, message: value === undefined ? 'is required' : 'must be a string' });
        return undefined;
      }
      const s = rules.trim === false ? value : value.trim();
      if (rules.min !== undefined && s.length < rules.min) issues.push({ path, message: `must be at least ${rules.min} characters` });
      else if (rules.max !== undefined && s.length > rules.max) issues.push({ path, message: `must be at most ${rules.max} characters` });
      else if (rules.pattern && !rules.pattern.test(s)) issues.push({ path, message: rules.patternMessage ?? 'has an invalid format' });
      else return s;
      return undefined;
    };
  },

  boolean(): Validator<boolean> {
    return (value, path, issues) => {
      if (typeof value === 'boolean') return value;
      issues.push({ path, message: value === undefined ? 'is required' : 'must be a boolean' });
      return undefined;
    };
  },

  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (value, path, issues) => (value === undefined || value === null ? undefined : inner(value, path, issues));
  },

  /** Unknown keys are rejected so typos and smuggled fields are visible. */
  object<S extends Record<string, Validator<unknown>>>(shape: S): Validator<{ [K in keyof S]: Infer<S[K]> }> {
    return (value, path, issues) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        issues.push({ path: path || '(body)', message: 'must be an object' });
        return undefined;
      }
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const before = issues.length;
      for (const key of Object.keys(input)) {
        if (!(key in shape)) issues.push({ path: path ? `${path}.${key}` : key, message: 'is not allowed' });
      }
      for (const [key, validator] of Object.entries(shape)) {
        const result = validator(input[key], path ? `${path}.${key}` : key, issues);
        if (result !== undefined) out[key] = result;
      }
      return issues.length === before ? (out as { [K in keyof S]: Infer<S[K]> }) : undefined;
    };
  },
};

/** Validates `value` or throws VALIDATION_ERROR listing every issue. */
export function parse<T>(validator: Validator<T>, value: unknown): T {
  const issues: FieldIssue[] = [];
  const result = validator(value, '', issues);
  if (issues.length || result === undefined) {
    throw errors.validation(issues.length ? issues : [{ path: '(body)', message: 'is invalid' }]);
  }
  return result;
}
