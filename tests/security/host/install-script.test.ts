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

// The Ubuntu installer (deploy/install.sh): it installs the same Bun as the Docker image, checked
// against hashes written in the script, into the paths the hardened unit expects, never pipes a
// download into a shell, refuses hostile arguments before doing anything, and never takes a
// missing terminal for a "yes". It was run end to end on Ubuntu 24.04 under systemd 255
// (fresh install, upgrade with --domain, the failure paths; docs/install.md).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..', '..', '..');
const path = join(repo, 'deploy', 'install.sh');
const script = readFileSync(path, 'utf8');
const unit = readFileSync(join(repo, 'deploy', 'clawrouter.service'), 'utf8');
const code = script.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const bash = (...args: string[]) => Bun.spawnSync(['bash', path, ...args], { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NO_COLOR: '1' } });

describe('the Ubuntu installer', () => {
  test('is valid bash and stops on any error', () => {
    expect(Bun.spawnSync(['bash', '-n', path]).exitCode).toBe(0);
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(code).toContain('set -Eeuo pipefail');
  });

  test.if(Bun.which('shellcheck') !== null)('passes shellcheck', () => {
    const r = Bun.spawnSync(['shellcheck', path], { stdout: 'pipe' });
    expect(r.stdout.toString()).toBe('');
    expect(r.exitCode).toBe(0);
  });

  test('installs the Bun version of the Docker image, checked against a SHA-256 for each build', () => {
    const docker = /oven\/bun:(\d+\.\d+\.\d+)/.exec(readFileSync(join(repo, 'Dockerfile'), 'utf8'))![1];
    expect(/BUN_VERSION="([^"]+)"/.exec(script)![1]).toBe(docker!);
    for (const build of ['bun-linux-x64', 'bun-linux-x64-baseline', 'bun-linux-aarch64']) {
      expect([build, new RegExp(`\\[${build}\\]="[0-9a-f]{64}"`).test(script)]).toEqual([build, true]);
    }
    expect(code).toContain('[[ "$actual" == "$expected" ]]');
  });

  test('never pipes a download into a shell, and clones the repository named in package.json', () => {
    // Commands only: the help text tells the user to run `curl … | sudo bash` themselves.
    const commands = code.split('\n').filter((l) => !/printf|fail |usage/.test(l)).join('\n');
    expect(commands).not.toMatch(/(curl|wget)[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/);
    expect(commands).not.toMatch(/\b(bash|sh)\s+<\(\s*(curl|wget)/);
    expect(commands).toMatch(/curl -fsSL --retry 3 -o "\$tmp\/bun\.zip"/);
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { repository: { url: string } };
    expect(pkg.repository.url).toContain(/REPO_URL="https:\/\/github\.com\/([^"]+)"/.exec(script)![1]!);
  });

  test('installs into the paths the hardened unit uses', () => {
    expect(unit).toContain('WorkingDirectory=/opt/clawrouter/dist');
    expect(unit).toContain('ExecStart=/usr/local/bin/bun main.js');
    expect(unit).toContain('EnvironmentFile=/etc/clawrouter/clawrouter.env');
    expect(unit).toContain('User=clawrouter');
    for (const v of ['DIST_DIR="$PREFIX/dist"', 'PREFIX="/opt/clawrouter"', 'BUN="/usr/local/bin/bun"', 'ENV_FILE="$CONF_DIR/clawrouter.env"', 'CONF_DIR="/etc/clawrouter"', 'SERVICE_USER="clawrouter"']) expect(script).toContain(v);
    // It installs the repository's own unit, not a copy of it.
    expect(code).toContain('"$SRC_DIR/deploy/clawrouter.service" "$UNIT_FILE"');
  });

  test('keeps an existing secret key and settings, and makes the key and log private', () => {
    expect(code).toContain('if [[ -s "$KEY_FILE" ]]');
    expect(code).toContain('(umask 077 && openssl rand -base64 32 >"$KEY_FILE")');
    expect(code).toContain('chmod 600 "$KEY_FILE"');
    expect(code).toContain('install -m 600 "$SRC_DIR/deploy/clawrouter.env.example" "$ENV_FILE"');
    expect(code).toContain('chmod 600 "$LOG"');
    // The key is never printed or logged; only where it is.
    expect(code).not.toMatch(/cat "\$KEY_FILE"|<"\$KEY_FILE"/);
  });

  test.each([
    [['--domain', 'x;rm -rf /'], 'Not a domain name'],
    [['--domain', '$(id)'], 'Not a domain name'],
    [['--port', '80'], 'The port must be'],
    [['--port', '8080;id'], 'The port must be'],
    [['--ref', '--upload-pack=touch /tmp/x'], 'Not a branch or tag name'],
    [['--ref', 'main;id'], 'Not a branch or tag name'],
    [['--nope'], 'Unknown option'],
  ])('refuses %p before doing anything', (args, message) => {
    const r = bash(...args);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain(message);
  });

  test('--help explains the options', () => {
    const r = bash('--help');
    expect(r.exitCode).toBe(0);
    for (const o of ['--domain', '--port', '--ref', '--yes', '--force']) expect(r.stdout.toString()).toContain(o);
  });

  test('waits for automatic updates instead of failing on the package lock, and shows how long steps take', () => {
    expect(code).toContain('if package_manager_busy; then');
    expect(code).toContain("pgrep -x 'apt|apt-get|aptitude|dpkg|unattended-upgr|unattended-upgrade'");
    for (const line of code.split('\n').filter((l) => /\bapt-get (-\S+ )*(update|install)\b/.test(l))) {
      expect([line.trim(), line.includes('-o DPkg::Lock::Timeout=600')]).toEqual([line.trim(), true]);
    }
    const r = Bun.spawnSync(['bash', '-c', `${/^elapsed\(\) \{[\s\S]*?^\}\n/m.exec(script)![0]}${/^took\(\) \{[\s\S]*?^\}\n/m.exec(script)![0]}SECONDS=200; elapsed 77; echo; took 199; echo; took 170; echo; took 75`], { stdout: 'pipe' });
    expect(r.stdout.toString()).toBe('2:03\n\n (30s)\n (2m 05s)');
  });

  test('asks on the terminal, and a missing terminal is never a yes', () => {
    expect(code).toContain('read -r answer </dev/tty');
    expect(code).toContain('fail "No terminal to ask for confirmation."');
  });
});
