import { describe, expect, test } from 'bun:test';
import { createLogger, type LogRecord } from '@clawapi/core';
import { createAuditService, createSqliteAuditRepository, type AuditRepository } from '../src/index.ts';
import { createHarness } from '../../../tests/support/harness.ts';

describe('audit', () => {
  test('records are stored with redacted metadata', () => {
    const h = createHarness();
    h.audit.record({ action: 'SETTINGS_CHANGED', result: 'SUCCESS', actor: { id: 'u1', name: 'ada' }, metadata: { key: 'x', apiKey: 'sk-123', nested: { password: 'p' } } });
    const [rec] = h.audit.list();
    expect(rec).toMatchObject({ action: 'SETTINGS_CHANGED', actorId: 'u1', actorName: 'ada', result: 'SUCCESS' });
    expect(rec!.metadata).toEqual({ key: 'x', apiKey: '[REDACTED]', nested: { password: '[REDACTED]' } });
    expect(JSON.stringify(h.db.all('SELECT * FROM audit_log'))).not.toContain('sk-123');
  });

  test('lists newest first with filters and keyset pagination', () => {
    const h = createHarness();
    for (const action of ['LOGIN', 'LOGOUT', 'LOGIN'] as const) {
      h.audit.record({ action, result: 'SUCCESS' });
      h.clock.advance(1000);
    }
    const all = h.audit.list();
    expect(all.map((r) => r.action)).toEqual(['LOGIN', 'LOGOUT', 'LOGIN']);
    expect(h.audit.list({ action: 'LOGIN' })).toHaveLength(2);
    expect(h.audit.list({ before: all[0]!.timestamp }).map((r) => r.action)).toEqual(['LOGOUT', 'LOGIN']);
    expect(h.audit.list({ limit: 1 })).toHaveLength(1);
  });

  test('a failing write is logged and does not throw', () => {
    const logs: LogRecord[] = [];
    const broken: AuditRepository = { append: () => { throw new Error('disk full'); }, list: () => [] };
    const audit = createAuditService(broken, createLogger({ sink: (r) => logs.push(r) }));
    expect(() => audit.record({ action: 'LOGIN', result: 'SUCCESS' })).not.toThrow();
    expect(logs.some((r) => r.msg === 'audit write failed')).toBe(true);
  });

  test('the repository is append-only', () => {
    const repo = createSqliteAuditRepository(createHarness().db);
    expect(Object.keys(repo).sort()).toEqual(['append', 'list']);
  });
});
