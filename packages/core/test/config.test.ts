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
    expect(loadConfig({ CLAWAPI_ENV: 'test' }).database.path).toBe(':memory:');
  });

  test('production defaults to JSON logs at info', () => {
    const config = loadConfig({ CLAWAPI_ENV: 'production', CLAWAPI_SECRET_KEY: 'a'.repeat(64) });
    expect(config.log).toEqual({ level: 'info', format: 'json' });
  });

  test('production requires a secret key for credential encryption', () => {
    expect(() => loadConfig({ CLAWAPI_ENV: 'production' })).toThrow('CLAWAPI_SECRET_KEY');
    expect(() => loadConfig({ CLAWAPI_SECRET_KEY: 'x', CLAWAPI_SECRET_KEY_FILE: '/k' })).toThrow('not both');
  });

  test('parses explicit values', () => {
    const config = loadConfig({ CLAWAPI_PORT: '9000', CLAWAPI_CONSOLE_ENABLED: 'off', CLAWAPI_LOG_LEVEL: 'warn' });
    expect(config.server.port).toBe(9000);
    expect(config.console.enabled).toBe(false);
    expect(config.log.level).toBe('warn');
  });

  test('reports every invalid value at once', () => {
    try {
      loadConfig({ CLAWAPI_PORT: 'abc', CLAWAPI_ENV: 'staging', CLAWAPI_CONSOLE_ENABLED: 'maybe' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const issues = (error as AppError).details?.issues ?? [];
      expect(issues.map((i) => i.path).sort()).toEqual(['CLAWAPI_CONSOLE_ENABLED', 'CLAWAPI_ENV', 'CLAWAPI_PORT']);
    }
  });

  test('config is immutable', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });
});
