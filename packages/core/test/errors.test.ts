/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

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
