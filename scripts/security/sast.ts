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

/**
 * Static analysis (SAST, SEC-026): rules written for ClawRouter's own code, run on the
 * TypeScript syntax tree (the compiler is already a development dependency; spec §47: no
 * scanner framework). Each rule names a pattern that has caused vulnerabilities elsewhere or
 * breaks a rule of AGENTS.md.
 *
 *   critical  always fails; cannot be waived
 *   high      fails unless waived in the code
 *   medium    reported only (review it)
 *
 * A waiver is a comment on the line of the finding or the line above it:
 *
 *   // security-waiver: <rule> -- <why this is safe, at least 15 characters>
 *
 * Waived findings stay in the report, so every exception remains visible.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SastSeverity = 'critical' | 'high' | 'medium';

export interface SastFinding {
  rule: string;
  severity: SastSeverity;
  file: string;
  line: number;
  message: string;
  snippet: string;
  /** The reason given in a waiver comment, when the finding is waived. */
  waived?: string;
}

export interface SastRule {
  id: string;
  severity: SastSeverity;
  description: string;
  /** Files the rule applies to (repository-relative paths). Default: every scanned file. */
  applies?: (file: string) => boolean;
  check: (node: ts.Node, report: (node: ts.Node, message: string) => void) => void;
}

const TLS_ENV = 'NODE_TLS_REJECT_UNAUTHORIZED';
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'cmd', 'cmd.exe', 'powershell', 'pwsh']);
const HTML_SINKS = new Set(['innerHTML', 'outerHTML']);
const HTML_CALLS = new Set(['insertAdjacentHTML', 'write', 'writeln']);
const SQL_METHODS = new Set(['run', 'get', 'all', 'exec', 'prepare', 'query']);
const SQL_TEXT = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|PRAGMA|REPLACE)\b/i;

const text = (n: ts.Node | undefined): string | undefined => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);
const calleeName = (call: ts.CallExpression | ts.NewExpression): string | undefined => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
};
const objectName = (call: ts.CallExpression): string | undefined => {
  const e = call.expression;
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) ? e.expression.text : undefined;
};
const propertyName = (p: ts.ObjectLiteralElementLike): string | undefined =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;

export const RULES: SastRule[] = [
  {
    id: 'no-eval', severity: 'critical',
    description: 'eval, new Function and string timers run text as code.',
    check(node, report) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') report(node, 'eval() runs text as code.');
      if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') report(node, 'Function() builds code from text.');
      if (ts.isCallExpression(node) && ['setTimeout', 'setInterval'].includes(calleeName(node) ?? '') && text(node.arguments[0]) !== undefined) report(node, 'A timer given a string runs it as code.');
    },
  },
  {
    id: 'html-injection', severity: 'high',
    description: 'Writing HTML from strings bypasses React\'s escaping (XSS).',
    check(node, report) {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'dangerouslySetInnerHTML') report(node, 'dangerouslySetInnerHTML writes unescaped HTML.');
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && HTML_SINKS.has(node.left.name.text)) report(node, `Assigning ${node.left.name.text} parses a string as HTML.`);
      if (ts.isCallExpression(node) && HTML_CALLS.has(calleeName(node) ?? '') && (calleeName(node) === 'insertAdjacentHTML' || objectName(node) === 'document')) report(node, `${calleeName(node)}() parses a string as HTML.`);
    },
  },
  {
    id: 'tls-verification-disabled', severity: 'high',
    description: 'Turning off certificate verification allows a man in the middle (SEC-007).',
    check(node, report) {
      if (ts.isPropertyAssignment(node) && propertyName(node) === 'rejectUnauthorized' && node.initializer.kind === ts.SyntaxKind.FalseKeyword) report(node, 'rejectUnauthorized: false turns off certificate verification.');
      if (ts.isPropertyAssignment(node) && propertyName(node) === 'checkServerIdentity' && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) report(node, 'A custom checkServerIdentity can accept any certificate.');
      // Setting it (process.env.X = …, env['X'] = …, or { X: … } in a child's environment), not naming it.
      const named = (n: ts.Node) => (ts.isPropertyAccessExpression(n) && n.name.text === TLS_ENV) || (ts.isElementAccessExpression(n) && text(n.argumentExpression) === TLS_ENV);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && named(node.left)) report(node, `${TLS_ENV} turns off certificate verification for the whole process.`);
      if (ts.isPropertyAssignment(node) && propertyName(node) === TLS_ENV) report(node, `${TLS_ENV} turns off certificate verification for the process it is given to.`);
    },
  },
  {
    id: 'shell-command', severity: 'high',
    description: 'Commands run through a shell (or child_process) can be injected; pass an argument array to Bun.spawn.',
    check(node, report) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ['child_process', 'node:child_process'].includes(text(node.moduleSpecifier) ?? '')) report(node, 'child_process: use Bun.spawn with an argument array.');
      if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === '$') report(node, 'The Bun shell ($``) interprets its text.');
      if (ts.isCallExpression(node) && ['spawn', 'spawnSync'].includes(calleeName(node) ?? '') && objectName(node) === 'Bun') {
        const first = node.arguments[0];
        const argv = first && ts.isArrayLiteralExpression(first) ? first.elements : first && ts.isObjectLiteralExpression(first) ? undefined : undefined;
        const program = argv?.[0] && text(argv[0]);
        if (program && SHELLS.has(program.split('/').pop()!)) report(node, `Bun.spawn runs a shell (${program}).`);
      }
    },
  },
  {
    id: 'sqlite-outside-database', severity: 'high',
    description: 'Only packages/database talks to SQLite (AGENTS.md rule 3): queries elsewhere skip the repositories.',
    applies: (file) => !file.startsWith('packages/database/'),
    check(node, report) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && text(node.moduleSpecifier) === 'bun:sqlite') report(node, 'bun:sqlite imported outside packages/database.');
    },
  },
  {
    id: 'unguarded-outbound-fetch', severity: 'high',
    description: 'Every outbound connection from the domain packages goes through the outbound guard (SEC-001); the global fetch skips it.',
    applies: (file) => file.startsWith('packages/') && !file.startsWith('packages/security/'),
    check(node, report) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') report(node, 'The global fetch() skips the outbound guard.');
      if (ts.isCallExpression(node) && calleeName(node) === 'fetch' && objectName(node) === 'globalThis') report(node, 'globalThis.fetch() skips the outbound guard.');
    },
  },
  {
    id: 'insecure-random', severity: 'high',
    description: 'Math.random is predictable: tokens, keys, codes and ids need crypto.getRandomValues / randomUUID.',
    check(node, report) {
      if (ts.isCallExpression(node) && calleeName(node) === 'random' && objectName(node) === 'Math') report(node, 'Math.random() is not a secure random source.');
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Math' && node.name.text === 'random' && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) report(node, 'Math.random passed on as a random source.');
    },
  },
  {
    id: 'wildcard-cors', severity: 'high',
    description: 'Access-Control-Allow-Origin: * lets any site read the answer (SEC-032).',
    check(node, report) {
      if (ts.isCallExpression(node) && ['set', 'append'].includes(calleeName(node) ?? '') && /^access-control-allow-origin$/i.test(text(node.arguments[0]) ?? '') && text(node.arguments[1]) === '*') report(node, 'Access-Control-Allow-Origin set to *.');
      if (ts.isPropertyAssignment(node) && /^access-control-allow-origin$/i.test(propertyName(node) ?? '') && text(node.initializer) === '*') report(node, 'Access-Control-Allow-Origin set to *.');
    },
  },
  {
    id: 'debugger-statement', severity: 'high',
    description: 'A debugger statement left in shipped code.',
    check(node, report) {
      if (node.kind === ts.SyntaxKind.DebuggerStatement) report(node, 'debugger statement.');
    },
  },
  {
    id: 'sql-interpolation', severity: 'medium',
    description: 'SQL text built with ${…}: check that only placeholders, column names from a fixed list or fragments the code wrote are interpolated, never a value.',
    check(node, report) {
      if (ts.isCallExpression(node) && SQL_METHODS.has(calleeName(node) ?? '') && ts.isPropertyAccessExpression(node.expression)) {
        const sql = node.arguments[0];
        if (sql && ts.isTemplateExpression(sql) && SQL_TEXT.test(sql.head.text)) report(node, `SQL built with ${sql.templateSpans.length} interpolation(s).`);
      }
    },
  },
  {
    id: 'weak-hash', severity: 'medium',
    description: 'MD5 and SHA-1 are broken for integrity and passwords (HMAC-SHA1 for TOTP, RFC 6238, is not affected).',
    check(node, report) {
      if (ts.isCallExpression(node) && calleeName(node) === 'createHash' && /^(md5|sha1|md4)$/i.test(text(node.arguments[0]) ?? '')) report(node, `createHash('${text(node.arguments[0])}').`);
      if (ts.isNewExpression(node) && calleeName(node) === 'CryptoHasher' && /^(md5|sha1|md4)$/i.test(text(node.arguments?.[0]) ?? '')) report(node, `CryptoHasher('${text(node.arguments?.[0])}').`);
    },
  },
  {
    id: 'console-in-library', severity: 'medium',
    description: 'Domain packages log through the logger, which redacts secrets (AGENTS.md rule 6); console output is not redacted.',
    applies: (file) => file.startsWith('packages/') && !file.startsWith('packages/shared/'),
    check(node, report) {
      if (ts.isCallExpression(node) && objectName(node) === 'console') report(node, `console.${calleeName(node)}() is not redacted.`);
    },
  },
];

const WAIVER = /security-waiver:\s*([a-z-]+)\s*--\s*(.+?)\s*(?:\*\/)?\s*$/;

/** The waiver for `rule` on `line` (1-based) or the line above, if any. */
export function waiverFor(lines: string[], line: number, rule: string): string | undefined {
  for (const l of [lines[line - 1], lines[line - 2]]) {
    const m = l ? WAIVER.exec(l) : null;
    if (m && m[1] === rule && m[2]!.length >= 15) return m[2];
  }
  return undefined;
}

/** Scans one file's source. `file` is its repository-relative path. */
export function scanSource(file: string, source: string, rules: SastRule[] = RULES): SastFinding[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split('\n');
  const active = rules.filter((r) => !r.applies || r.applies(file));
  const findings: SastFinding[] = [];
  const visit = (node: ts.Node) => {
    for (const rule of active) {
      rule.check(node, (at, message) => {
        const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
        const waived = rule.severity === 'critical' ? undefined : waiverFor(lines, line, rule.id);
        findings.push({ rule: rule.id, severity: rule.severity, file, line, message, snippet: lines[line - 1]!.trim().slice(0, 200), ...(waived ? { waived } : {}) });
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/** Shipped source: apps, packages and scripts, without tests. */
export function sastFiles(root: string): string[] {
  // Tracked and new (untracked, not ignored) files, so a local run sees what CI will.
  const p = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'scripts'], { cwd: root, stdout: 'pipe' });
  return [...new Set(p.stdout.toString().split('\n'))].filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !/(^|\/)tests?\//.test(f) && !/\.test\.tsx?$/.test(f));
}

export interface SastReport {
  files: number;
  findings: SastFinding[];
  /** Findings that fail the check: every critical one, and high ones without a waiver. */
  blocking: SastFinding[];
  /** Waiver comments that match no finding (stale: remove them). */
  unusedWaivers: string[];
}

export function runSast(root: string, files = sastFiles(root)): SastReport {
  const findings: SastFinding[] = [];
  const unusedWaivers: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    const found = scanSource(file, source);
    findings.push(...found);
    source.split('\n').forEach((l, i) => {
      const m = WAIVER.exec(l);
      if (m && !found.some((f) => f.rule === m[1] && f.waived && (f.line === i + 1 || f.line === i + 2))) unusedWaivers.push(`${file}:${i + 1}: waiver for "${m[1]}" matches no finding${m[2]!.length < 15 ? ' (its reason is too short)' : ''}`);
    });
  }
  const blocking = findings.filter((f) => f.severity === 'critical' || (f.severity === 'high' && !f.waived));
  return { files: files.length, findings, blocking, unusedWaivers };
}
