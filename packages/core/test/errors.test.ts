import { describe, expect, test } from 'bun:test';
import { AppError, errors, httpStatusFor, normalizeError } from '../src/index.ts';

describe('AppError', () => {
  test('maps codes to HTTP status', () => {
    expect(httpStatusFor('VALIDATION_ERROR')).toBe(400);
    expect(httpStatusFor('AUTHENTICATION_ERROR')).toBe(401);
    expect(httpStatusFor('AUTHORIZATION_ERROR')).toBe(403);
    expect(httpStatusFor('RATE_LIMITED')).toBe(429);
    expect(httpStatusFor('PROVIDER_TIMEOUT')).toBe(504);
  });

  test('client errors expose their message', () => {
    expect(new AppError('CONFLICT', 'Name already used').publicMessage).toBe('Name already used');
  });

  test('server errors hide their message', () => {
    const error = new AppError('DATABASE_ERROR', 'SQLITE_CORRUPT at /var/lib/secret.db');
    expect(error.publicMessage).toBe('A database error occurred.');
  });

  test('normalizeError wraps unknown errors as INTERNAL_ERROR and keeps the cause', () => {
    const cause = new Error('boom');
    const error = normalizeError(cause);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.cause).toBe(cause);
    expect(error.publicMessage).not.toContain('boom');
  });

  test('normalizeError returns AppErrors unchanged', () => {
    const error = errors.notFound();
    expect(normalizeError(error)).toBe(error);
  });

  test('methodNotAllowed sets the Allow header', () => {
    expect(errors.methodNotAllowed(['GET', 'HEAD']).headers).toEqual({ Allow: 'GET, HEAD' });
  });
});
