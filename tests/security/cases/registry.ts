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
 * The security regression corpus (SEC-027). Every vulnerability found in ClawRouter becomes a
 * case here, with the test that shows it, and stays: the rule is "fix, add the case, merge the
 * fix only with it" (README.md in this folder). The corpus also holds an attack case for every
 * class the roadmap names, so each class is guarded even before anything was found in it.
 *
 * A case's test lives in `<class>.test.ts` in this folder and its name starts with the case id
 * ("CASE-007: ..."). corpus.test.ts checks that every case has exactly one test, every test here
 * a case, and every class a file.
 */

export const CLASSES = [
  'ssrf', 'csrf', 'xss', 'path-traversal', 'authorization-bypass', 'session-fixation', 'api-key-leakage', 'secret-leakage',
  'mcp-privilege-escalation', 'request-smuggling', 'http-desync', 'dns-rebinding', 'denial-of-service', 'configuration-injection',
  'backup-restore', 'websocket-authorization', 'provider-credential-leakage',
] as const;

export type CaseClass = (typeof CLASSES)[number];

export interface SecurityCase {
  /** CASE-NNN, never reused. */
  id: string;
  class: CaseClass;
  title: string;
  /**
   * `found`: a vulnerability that existed in ClawRouter (when, how it was found, what fixed it).
   * `attack`: an attack that was never possible here, kept so it never becomes possible.
   */
  origin: { kind: 'found'; date: string; foundBy: string; fix: string } | { kind: 'attack' };
}

const found = (date: string, foundBy: string, fix: string) => ({ kind: 'found' as const, date, foundBy, fix });
const attack = { kind: 'attack' as const };

export const CASES: SecurityCase[] = [
  { id: 'CASE-001', class: 'ssrf', title: 'Provider URLs that point inside the network or at cloud metadata are refused before connecting', origin: attack },
  { id: 'CASE-002', class: 'ssrf', title: 'A call refused by the outbound policy is not retried against the same endpoint', origin: found('2026-11-19', 'review of security phase 1', 'policy refusals became the `blocked` failure kind: next model, no retry (packages/gateway executor)') },
  { id: 'CASE-003', class: 'ssrf', title: 'Metadata addresses stay refused even when an administrator allowlists their range', origin: attack },
  { id: 'CASE-004', class: 'csrf', title: 'A cross-site page cannot change anything with the console cookie', origin: attack },
  { id: 'CASE-005', class: 'csrf', title: 'Form encodings a cross-site HTML form can send are refused', origin: attack },
  { id: 'CASE-006', class: 'xss', title: 'Client text reflected in an error is JSON that a browser will not run or sniff as HTML', origin: attack },
  { id: 'CASE-007', class: 'xss', title: 'The console page allows only its own scripts', origin: attack },
  { id: 'CASE-008', class: 'path-traversal', title: 'The console file server serves only bundle files, whatever the path encoding', origin: attack },
  { id: 'CASE-009', class: 'path-traversal', title: 'Identifiers in an imported configuration cannot carry a path', origin: attack },
  { id: 'CASE-010', class: 'authorization-bypass', title: 'Path variants of a protected route never bypass its access check', origin: attack },
  { id: 'CASE-011', class: 'authorization-bypass', title: 'An import cannot change a role that holds permissions the importer lacks', origin: found('2026-11-20', 'building the configuration import sandbox (SEC-017)', 'missingPermissions counts the permissions a changed role has now, not only the new ones') },
  { id: 'CASE-012', class: 'authorization-bypass', title: 'A Viewer cannot raise their own access through role assignment', origin: attack },
  { id: 'CASE-013', class: 'session-fixation', title: 'A session token chosen by an attacker never becomes valid; sign-in issues a new one', origin: attack },
  { id: 'CASE-014', class: 'session-fixation', title: 'A token copied before sign-out is useless afterwards', origin: attack },
  { id: 'CASE-015', class: 'api-key-leakage', title: 'An API key secret is shown once and is never in lists, logs, audit records or the request history', origin: attack },
  { id: 'CASE-016', class: 'api-key-leakage', title: 'An API key in the URL is not accepted', origin: attack },
  { id: 'CASE-017', class: 'secret-leakage', title: 'An imported mail password is refused, never stored', origin: found('2026-11-20', 'building the configuration import sandbox (SEC-017)', 'mail.update receives only the allowed fields; secrets in a document are refused') },
  { id: 'CASE-018', class: 'secret-leakage', title: 'The mail password and the setup token never appear in answers or logs', origin: attack },
  { id: 'CASE-019', class: 'mcp-privilege-escalation', title: 'MCP tools use the key owner\'s permissions as they are now, read on every call', origin: attack },
  { id: 'CASE-020', class: 'mcp-privilege-escalation', title: 'No MCP tool changes anything or returns a secret', origin: attack },
  { id: 'CASE-021', class: 'request-smuggling', title: 'Ambiguous request framing (Content-Length with Transfer-Encoding, two lengths, disguised chunking) is refused and closes the connection', origin: attack },
  { id: 'CASE-022', class: 'http-desync', title: 'A body the server answers without reading is never parsed as the next request', origin: attack },
  { id: 'CASE-023', class: 'http-desync', title: 'Malformed line endings, folded headers and NUL bytes are refused', origin: attack },
  { id: 'CASE-024', class: 'dns-rebinding', title: 'A provider name that turns private between lookups never reaches the private address', origin: attack },
  { id: 'CASE-025', class: 'dns-rebinding', title: 'A rebound browser page without the session cookie can neither set up nor use the server', origin: attack },
  { id: 'CASE-026', class: 'denial-of-service', title: 'A stream piece that gives the client nothing does not stall the stream or hold its slot', origin: found('2026-11-20', 'fuzz testing (SEC-021)', 'the stream pull loops until it enqueues something or closes (packages/gateway service)') },
  { id: 'CASE-027', class: 'denial-of-service', title: 'Oversized and deeply nested bodies are refused before they are processed', origin: attack },
  { id: 'CASE-028', class: 'configuration-injection', title: 'An imported routing document cannot set its own version', origin: found('2026-11-20', 'building the configuration import sandbox (SEC-017)', 'the sandbox refuses unknown fields; the service sets the version after the document') },
  { id: 'CASE-029', class: 'configuration-injection', title: 'Prototype keys and unknown fields in an import are refused, and nothing is applied', origin: attack },
  { id: 'CASE-030', class: 'backup-restore', title: 'A backup whose database is a symbolic link is refused, and the link target is never read', origin: attack },
  { id: 'CASE-031', class: 'backup-restore', title: 'A crafted backup with a matching checksum but an extra trigger is refused', origin: attack },
  { id: 'CASE-032', class: 'websocket-authorization', title: 'The live channel needs a console session from the same origin', origin: attack },
  { id: 'CASE-033', class: 'websocket-authorization', title: 'An account that must change its password cannot open the live channel', origin: attack },
  { id: 'CASE-034', class: 'provider-credential-leakage', title: 'Provider error text (account ids, upgrade links) is not passed to clients', origin: found('2026-11-19', 'live testing with Groq', 'clients get ClawRouter\'s own words for provider 400s; the provider text stays in the log (rejectedMessage)') },
  { id: 'CASE-035', class: 'provider-credential-leakage', title: 'A stored provider key is never sent to a new host', origin: attack },
  { id: 'CASE-036', class: 'provider-credential-leakage', title: 'Provider keys never appear in answers, exports, audit records or logs', origin: attack },
];
