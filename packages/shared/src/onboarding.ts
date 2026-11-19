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
 * First-run onboarding (owner request, 2026-11-16): a setup wizard for the
 * installation, run by an administrator after the first one is created, and a
 * guided tour of the console that every new user sees once, at their first
 * sign-in, limited to the pages their role can open. Both can be skipped.
 */

/** Steps of the setup wizard, in order. */
export const SETUP_WIZARD_STEPS = ['provider', 'models', 'api_key', 'test_request', 'mail', 'sign_in'] as const;
export type SetupWizardStep = (typeof SETUP_WIZARD_STEPS)[number];

export const SETUP_WIZARD_STATUSES = ['PENDING', 'COMPLETED', 'DISMISSED'] as const;
export type SetupWizardStatus = (typeof SETUP_WIZARD_STATUSES)[number];

export interface SetupWizardState {
  status: SetupWizardStatus;
  /** Where to resume a pending wizard; null: the start. */
  step: SetupWizardStep | null;
}

export const TOUR_STATES = ['PENDING', 'COMPLETED', 'SKIPPED'] as const;
export type TourState = (typeof TOUR_STATES)[number];

/** Part of the session: what onboarding the console should offer this user. */
export interface OnboardingInfo {
  /** This user's guided tour: PENDING shows it at sign-in. */
  tour: TourState;
  /** The installation's setup wizard; null for users who cannot change settings. */
  setupWizard: SetupWizardState | null;
}

/** PUT /api/onboarding/setup-wizard */
export interface UpdateSetupWizardRequest {
  status: SetupWizardStatus;
  step?: SetupWizardStep | null;
}

/** POST /api/auth/tour */
export interface FinishTourRequest {
  outcome: 'COMPLETED' | 'SKIPPED';
}
