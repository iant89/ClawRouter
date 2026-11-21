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

// SEC-026 SAST: each rule finds what it is for, leaves the safe form alone, and the repository passes.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { RULES, runSast, scanSource } from '../../../scripts/security/sast.ts';

const repo = join(import.meta.dir, '..', '..', '..');
const rules = (file: string, source: string) => scanSource(file, source).map((f) => f.rule);

describe('SAST rules (SEC-026)', () => {
  test.each([
    ['no-eval', 'eval(userText);'],
    ['no-eval', 'const f = new Function("a", body);'],
    ['no-eval', 'setTimeout("alert(1)", 10);'],
    ['html-injection', 'el.innerHTML = name;'],
    ['html-injection', 'el.insertAdjacentHTML("beforeend", html);'],
    ['html-injection', 'document.write(page);'],
    ['tls-verification-disabled', 'fetch(url, { tls: { rejectUnauthorized: false } });'],
    ['tls-verification-disabled', 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";'],
    ['tls-verification-disabled', 'connect({ checkServerIdentity: () => undefined });'],
    ['shell-command', "import { exec } from 'node:child_process';"],
    ['shell-command', "Bun.spawn(['sh', '-c', `tar ${name}`]);"],
    ['shell-command', "Bun.spawnSync(['/bin/bash', '-c', cmd]);"],
    ['shell-command', 'await $`rm ${path}`;'],
    ['sqlite-outside-database', "import { Database } from 'bun:sqlite';"],
    ['insecure-random', 'const token = Math.random().toString(36);'],
    ['insecure-random', 'pick(items, Math.random);'],
    ['wildcard-cors', "headers.set('Access-Control-Allow-Origin', '*');"],
    ['wildcard-cors', "new Response(body, { headers: { 'access-control-allow-origin': '*' } });"],
    ['debugger-statement', 'debugger;'],
    ['sql-interpolation', 'db.run(`DELETE FROM users WHERE name = \'${name}\'`);'],
    ['weak-hash', "createHash('md5').update(x);"],
  ])('%s: %s', (rule, source) => {
    expect(rules('packages/demo/src/x.ts', source)).toContain(rule);
  });

  test('JSX: dangerouslySetInnerHTML', () => {
    expect(rules('apps/console/src/x.tsx', 'const a = <div dangerouslySetInnerHTML={{ __html: text }} />;')).toEqual(['html-injection']);
  });

  test('package-scoped rules', () => {
    expect(rules('packages/providers/src/x.ts', 'await fetch(url);')).toEqual(['unguarded-outbound-fetch']);
    expect(rules('packages/security/src/x.ts', 'await fetch(url);')).toEqual([]);
    expect(rules('apps/server/src/x.ts', 'await fetch(url);')).toEqual([]);
    expect(rules('packages/database/src/x.ts', "import { Database } from 'bun:sqlite';")).toEqual([]);
    expect(rules('packages/gateway/src/x.ts', 'console.log(request);')).toEqual(['console-in-library']);
    expect(rules('apps/server/src/main.ts', 'console.log("started");')).toEqual([]);
  });

  test('the safe forms are not reported', () => {
    for (const source of [
      'el.textContent = name;',
      "guard.fetch(url, { tls: { rejectUnauthorized: true } });",
      "Bun.spawn(['git', 'ls-files']);",
      'const id = crypto.randomUUID();',
      "headers.set('Access-Control-Allow-Origin', origin);",
      "db.run('DELETE FROM users WHERE name = ?', [name]);",
      "db.run(`SELECT 1 WHERE id = ?`, [id]);",
      "createHmac('sha1', secret);",
      'const text = "eval(x) and Math.random() in a string";',
      '// eval(x); Math.random(); debugger;',
      'obj.eval(x);',
    ]) expect([source, rules('packages/demo/src/x.ts', source)]).toEqual([source, []]);
  });

  test('a high finding can be waived with a reason; critical ones cannot', () => {
    const waived = scanSource('packages/demo/src/x.ts', "// security-waiver: insecure-random -- jitter for retries only, guards nothing\nconst j = Math.random();\n");
    expect(waived[0]!.waived).toBe('jitter for retries only, guards nothing');
    const sameLine = scanSource('packages/demo/src/x.ts', 'const j = Math.random(); // security-waiver: insecure-random -- jitter for retries only\n');
    expect(sameLine[0]!.waived).toBeDefined();
    const short = scanSource('packages/demo/src/x.ts', '// security-waiver: insecure-random -- because\nconst j = Math.random();\n');
    expect(short[0]!.waived).toBeUndefined();
    const other = scanSource('packages/demo/src/x.ts', '// security-waiver: wildcard-cors -- a waiver for another rule here\nconst j = Math.random();\n');
    expect(other[0]!.waived).toBeUndefined();
    const critical = scanSource('packages/demo/src/x.ts', '// security-waiver: no-eval -- I am sure this one is fine really\neval(x);\n');
    expect(critical[0]!.waived).toBeUndefined();
  });

  test('every rule has an id, a severity and a description', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) expect(r.description.length).toBeGreaterThan(20);
  });

  test('the repository passes: no critical finding, every high one fixed or waived, no stale waiver', () => {
    const report = runSast(repo);
    expect(report.files).toBeGreaterThan(300);
    expect(report.blocking.map((f) => `${f.file}:${f.line} ${f.rule}`)).toEqual([]);
    expect(report.unusedWaivers).toEqual([]);
  });

  test('tests are not scanned, shipped source is', () => {
    const report = runSast(repo);
    expect(report.findings.some((f) => /(^|\/)tests?\//.test(f.file))).toBe(false);
  });
});
