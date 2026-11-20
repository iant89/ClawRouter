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

// SEC-024: the systemd unit runs ClawRouter in a sandbox. The directives were run under
// systemd 255 with the production build (docs/security-roadmap.md#sec-024): these tests keep
// them from being dropped or weakened, and ask systemd's own analyzer where it is installed.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const unitPath = join(import.meta.dir, '..', '..', '..', 'deploy', 'clawrouter.service');
const unit = readFileSync(unitPath, 'utf8');

/** The [Service] section's directives, every value of each (later lines add to or reset earlier ones). */
function service(): Map<string, string[]> {
  const section = unit.split(/^\[Service\]$/m)[1]!.split(/^\[/m)[0]!;
  const out = new Map<string, string[]>();
  for (const line of section.split('\n')) {
    const m = line.match(/^([A-Za-z]+)=(.*)$/);
    if (m) out.set(m[1]!, [...(out.get(m[1]!) ?? []), m[2]!.trim()]);
  }
  return out;
}
const directives = service();
const value = (name: string) => directives.get(name)?.at(-1);

describe('systemd hardening (SEC-024)', () => {
  test('runs as its own account, never root', () => {
    expect(value('User')).toBe('clawrouter');
    expect(value('Group')).toBe('clawrouter');
    expect(directives.has('DynamicUser')).toBe(false);
  });

  test('every directive the roadmap names is on', () => {
    for (const name of ['NoNewPrivileges', 'PrivateTmp', 'ProtectHome', 'ProtectKernelTunables', 'ProtectKernelModules', 'ProtectControlGroups',
      'RestrictSUIDSGID', 'LockPersonality', 'RestrictRealtime', 'RestrictNamespaces']) {
      expect([name, value(name)]).toEqual([name, 'true']);
    }
    expect(value('ProtectSystem')).toBe('strict');
  });

  test('and the further ones that were run with ClawRouter', () => {
    for (const name of ['PrivateDevices', 'ProtectKernelLogs', 'ProtectClock', 'ProtectHostname', 'RemoveIPC', 'PrivateUsers', 'PrivateIPC']) {
      expect([name, value(name)]).toEqual([name, 'true']);
    }
    expect(value('ProtectProc')).toBe('invisible');
    expect(value('ProcSubset')).toBe('pid');
    expect(value('UMask')).toBe('0077');
    expect(value('SystemCallArchitectures')).toBe('native');
    expect(directives.get('SystemCallFilter')).toEqual(['@system-service', '~@privileged @resources']);
    expect(value('RestrictAddressFamilies')).toBe('AF_INET AF_INET6 AF_UNIX');
  });

  test('no capabilities at all', () => {
    // An empty value clears the set: nothing to keep, nothing to pass on.
    expect(value('CapabilityBoundingSet')).toBe('');
    expect(value('AmbientCapabilities')).toBe('');
  });

  test('only the data directory is writable, and it is private', () => {
    expect(value('StateDirectory')).toBe('clawrouter');
    expect(value('StateDirectoryMode')).toBe('0700');
    expect(directives.has('ReadWritePaths')).toBe(false);
    expect(readFileSync(join(import.meta.dir, '..', '..', '..', 'deploy', 'clawrouter.env.example'), 'utf8')).toContain('CLAWROUTER_DATABASE_PATH=/var/lib/clawrouter/');
  });

  test('MemoryDenyWriteExecute stays off: it takes away the JavaScript JIT (measured 2.7x slower)', () => {
    expect(directives.has('MemoryDenyWriteExecute')).toBe(false);
    expect(unit).toContain('MemoryDenyWriteExecute=true (it takes away');
  });

  test.if(Bun.which('systemd-analyze') !== null)("systemd's analyzer rates the unit OK (exposure at most 2.0 of 10)", () => {
    const run = Bun.spawnSync(['systemd-analyze', 'security', '--offline=true', '--threshold=20', '--no-pager', unitPath], { stdout: 'pipe', stderr: 'pipe' });
    const text = run.stdout.toString() + run.stderr.toString();
    const score = Number(text.match(/Overall exposure level for clawrouter\.service: ([\d.]+)/)?.[1]);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeLessThanOrEqual(2);
    expect(run.exitCode).toBe(0);
  });
});
