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
 * Long-running operations (spec §26): work that takes longer than a request
 * should wait for, with status, progress, a result and cancellation.
 */
import type { Permission } from './authorization.ts';

export const OPERATION_STATUSES = ['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED'] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];
export const FINAL_OPERATION_STATUSES: readonly OperationStatus[] = ['SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED'];

/**
 * Operation types. `view`: permission to see operations of this type;
 * `run`: permission to start or cancel them; `target`: whether a target id
 * (e.g. a provider) is required.
 */
export const OPERATION_TYPES = {
  'health.check': { label: 'Run health checks', view: 'health.read', run: 'health.read', target: false },
  'provider.test': { label: 'Test provider connection', view: 'providers.read', run: 'providers.write', target: true },
  'providers.check': { label: 'Check all providers', view: 'providers.read', run: 'providers.write', target: false },
} as const satisfies Record<string, { label: string; view: Permission; run: Permission; target: boolean }>;

export type OperationType = keyof typeof OPERATION_TYPES;
export const isOperationType = (v: unknown): v is OperationType => typeof v === 'string' && Object.hasOwn(OPERATION_TYPES, v);

export interface OperationInfo {
  id: string;
  type: OperationType;
  targetId: string | null;
  /** Display name of the target (e.g. the provider's name), when known. */
  targetLabel: string | null;
  status: OperationStatus;
  /** 0–100. */
  progress: number;
  /** What it is doing now, or how it ended. */
  message: string | null;
  /** Type-specific outcome (no secrets). */
  result: unknown;
  error: string | null;
  createdBy: { id: string; username: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** POST /api/operations */
export interface StartOperationRequest {
  type: OperationType;
  targetId?: string;
}

/** GET /api/operations filters. */
export interface OperationQuery {
  page?: number;
  pageSize?: number;
  status?: OperationStatus;
  type?: OperationType;
}
