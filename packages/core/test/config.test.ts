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
import { AppError, loadConfig } from '../src/index.ts';

describe('loadConfig', () => {
  test('defaults are safe: loopback host, development, console on', () => {
    const config = loadConfig({});
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(8080);
    expect(config.env).toBe('development');
    expect(config.log.format).toBe('pretty');
    expect(config.console.enabled).toBe(true);
  });

  test('test environment uses an in-memory database', () => {
    expect(loadConfig({ CLAWROUTER_ENV: 'test' }).database.path).toBe(':memory:');
  });

  test('production defaults to JSON logs at info', () => {
    const config = loadConfig({ CLAWROUTER_ENV: 'production', CLAWROUTER_SECRET_KEY: 'a'.repeat(64) });
    expect(config.log).toEqual({ level: 'info', format: 'json', bufferSize: 5000 });
  });

  test('production requires a secret key for credential encryption', () => {
    expect(() => loadConfig({ CLAWROUTER_ENV: 'production' })).toThrow('CLAWROUTER_SECRET_KEY');
    expect(() => loadConfig({ CLAWROUTER_SECRET_KEY: 'x', CLAWROUTER_SECRET_KEY_FILE: '/k' })).toThrow('not both');
  });

  test('parses explicit values', () => {
    const config = loadConfig({ CLAWROUTER_PORT: '9000', CLAWROUTER_CONSOLE_ENABLED: 'off', CLAWROUTER_LOG_LEVEL: 'warn' });
    expect(config.server.port).toBe(9000);
    expect(config.console.enabled).toBe(false);
    expect(config.log.level).toBe('warn');
  });

  test('reports every invalid value at once', () => {
    try {
      loadConfig({ CLAWROUTER_PORT: 'abc', CLAWROUTER_ENV: 'staging', CLAWROUTER_CONSOLE_ENABLED: 'maybe' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const issues = (error as AppError).details?.issues ?? [];
      expect(issues.map((i) => i.path).sort()).toEqual(['CLAWROUTER_CONSOLE_ENABLED', 'CLAWROUTER_ENV', 'CLAWROUTER_PORT']);
    }
  });

  test('config is immutable', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('production options (phase 17): shutdown, port reuse, TLS, migrations, backups', () => {
    const defaults = loadConfig({ CLAWROUTER_DATABASE_PATH: '/srv/clawrouter/clawrouter.db' });
    expect(defaults.server).toMatchObject({ shutdownGraceSeconds: 30, reusePort: false, tls: null });
    expect(defaults.database).toMatchObject({ migrations: 'auto', backupBeforeMigrate: true, backupDir: '/srv/clawrouter/backups' });
    expect(loadConfig({ CLAWROUTER_ENV: 'test' }).database.backupBeforeMigrate).toBe(false); // in memory

    const set = loadConfig({
      CLAWROUTER_SHUTDOWN_GRACE_SECONDS: '90', CLAWROUTER_REUSE_PORT: 'true', CLAWROUTER_MIGRATIONS: 'manual',
      CLAWROUTER_BACKUP_BEFORE_MIGRATE: 'false', CLAWROUTER_BACKUP_DIR: '/backups',
      CLAWROUTER_TLS_CERT_FILE: '/tls/cert.pem', CLAWROUTER_TLS_KEY_FILE: '/tls/key.pem',
    });
    expect(set.server).toMatchObject({ shutdownGraceSeconds: 90, reusePort: true, tls: { certFile: '/tls/cert.pem', keyFile: '/tls/key.pem' } });
    expect(set.database).toMatchObject({ migrations: 'manual', backupBeforeMigrate: false, backupDir: '/backups' });
    // Served over HTTPS directly, cookies are Secure unless told otherwise.
    expect(set.auth.cookieSecure).toBe(true);
    expect(loadConfig({ CLAWROUTER_TLS_CERT_FILE: '/c', CLAWROUTER_TLS_KEY_FILE: '/k', CLAWROUTER_COOKIE_SECURE: 'false' }).auth.cookieSecure).toBe(false);

    expect(() => loadConfig({ CLAWROUTER_TLS_CERT_FILE: '/tls/cert.pem' })).toThrow('CLAWROUTER_TLS_KEY_FILE');
    expect(() => loadConfig({ CLAWROUTER_MIGRATIONS: 'sometimes' })).toThrow('CLAWROUTER_MIGRATIONS');
    expect(() => loadConfig({ CLAWROUTER_SHUTDOWN_GRACE_SECONDS: '9999' })).toThrow('CLAWROUTER_SHUTDOWN_GRACE_SECONDS');
  });
});

describe('outbound allowlist (SEC-001)', () => {
  const KEY = { CLAWROUTER_SECRET_KEY: 'x'.repeat(44) };
  test('development reaches loopback; production and test start closed', () => {
    expect(loadConfig({}).outbound.allowlist).toEqual(['localhost', '127.0.0.0/8', '::1']);
    expect(loadConfig({ CLAWROUTER_ENV: 'production', ...KEY }).outbound.allowlist).toEqual([]);
    expect(loadConfig({ CLAWROUTER_ENV: 'test' }).outbound.allowlist).toEqual([]);
  });

  test('an explicit value replaces the default, even an empty one', () => {
    expect(loadConfig({ CLAWROUTER_OUTBOUND_ALLOWLIST: '' }).outbound.allowlist).toEqual([]);
    expect(loadConfig({ CLAWROUTER_ENV: 'production', ...KEY, CLAWROUTER_OUTBOUND_ALLOWLIST: 'ollama, 192.168.1.0/24, *.lan' }).outbound.allowlist)
      .toEqual(['ollama', '192.168.1.0/24', '*.lan']);
  });

  test('invalid entries stop startup', () => {
    expect(() => loadConfig({ CLAWROUTER_OUTBOUND_ALLOWLIST: 'ollama, not a host' })).toThrow('CLAWROUTER_OUTBOUND_ALLOWLIST');
  });
});
