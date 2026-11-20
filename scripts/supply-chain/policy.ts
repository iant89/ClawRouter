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
 * The dependency policy (SEC-018). Every exception here is a reviewed decision: give the
 * reason, and for vulnerabilities a date after which the exception stops working.
 * See docs/supply-chain.md.
 */

/** Severities that fail the check. Lower ones are reported as warnings. */
export const FAILING_SEVERITIES = ['high', 'critical'] as const;

/**
 * Licenses a dependency may have (SPDX ids). All are permissive and compatible with
 * ClawRouter's AGPL-3.0-or-later. A dependency under anything else fails the check until
 * its license is reviewed and added here.
 */
export const ALLOWED_LICENSES: readonly string[] = [
  '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'CC-BY-4.0',
  'ISC', 'MIT', 'MIT-0', 'Unlicense', 'Zlib',
];

/** Packages whose package.json does not state a license, with the license read from their LICENSE file. */
export const LICENSE_OVERRIDES: Readonly<Record<string, { license: string; reason: string }>> = {
  '@enterprise-ui/react': {
    license: 'MIT',
    reason: 'Vendored ENTERPRISE-UI (vendor/enterprise-ui-react.tgz): its package.json has no license field; the LICENSE file in the tarball is MIT.',
  },
};

/** Known advisories accepted for a while. `expires` is YYYY-MM-DD (UTC); after it the advisory fails again. */
export interface AuditException {
  /** The advisory's GHSA id (or bun's numeric id). */
  id: string;
  package: string;
  reason: string;
  expires: string;
}
export const AUDIT_EXCEPTIONS: readonly AuditException[] = [];

/** The only registry packages may come from ("" in bun.lock means the default registry). */
export const ALLOWED_REGISTRIES: readonly string[] = ['', 'https://registry.npmjs.org/'];

/** Local tarballs packages may come from (relative to the repository root). */
export const ALLOWED_TARBALL_DIR = 'vendor/';

/**
 * Dependencies allowed to run install scripts (`trustedDependencies` in package.json). Bun runs
 * no dependency's lifecycle scripts unless it is listed there, so this stays empty.
 */
export const ALLOWED_LIFECYCLE_SCRIPTS: readonly string[] = [];
