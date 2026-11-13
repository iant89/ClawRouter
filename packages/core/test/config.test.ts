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
});
