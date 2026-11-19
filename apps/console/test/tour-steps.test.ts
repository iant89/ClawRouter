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
import { PERMISSIONS } from '@clawrouter/shared';
import { tourSteps } from '../src/features/onboarding/tour-steps.ts';

// The built-in Viewer role (packages/authorization/src/roles.ts).
const VIEWER = new Set(['providers.read', 'models.read', 'routing.read', 'rate_limits.read', 'requests.read', 'usage.read', 'health.read']);
const ADMIN = new Set<string>(PERMISSIONS);

describe('guided tour steps (owner request: by role)', () => {
  test('an administrator: welcome, dashboard, every area, then the header', () => {
    const steps = tourSteps(ADMIN, 'Ada');
    expect(steps.map((s) => s.id)).toEqual(['welcome', 'dashboard', 'gateway', 'ai', 'system', 'admin', 'health', 'notifications', 'help']);
    expect(steps[0]!.title).toBe('Welcome to ClawRouter, Ada');
    expect(steps.find((s) => s.id === 'gateway')!.target).toBe('nav a[href="/requests"]');
    expect(steps.find((s) => s.id === 'admin')!.text).toContain('Settings');
    expect(steps.find((s) => s.id === 'help')!.text).toContain('setup wizard');
  });

  test('a Viewer is never told about pages they cannot open', () => {
    const steps = tourSteps(VIEWER, 'Vera');
    expect(steps.map((s) => s.id)).toEqual(['welcome', 'dashboard', 'gateway', 'ai', 'system', 'health', 'notifications', 'help']);
    const all = steps.map((s) => s.text).join(' ');
    for (const hidden of ['API Access', 'Logs', 'Audit', 'Users', 'Settings', 'setup wizard']) expect(all).not.toContain(hidden);
    // My API keys needs no permission, so it is described instead of API Access.
    expect(all).toContain('My API keys');
  });

  test('someone with no role still gets a short tour of what they have', () => {
    const steps = tourSteps(new Set(), 'Nobody');
    expect(steps.map((s) => s.id)).toEqual(['welcome', 'dashboard', 'gateway', 'health', 'notifications', 'help']);
    expect(steps.find((s) => s.id === 'gateway')!.target).toBe('nav a[href="/my-keys"]');
  });
});
