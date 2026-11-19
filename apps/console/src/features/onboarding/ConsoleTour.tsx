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

import { useMemo } from 'react';
import { Tour, type TourStep } from '@enterprise-ui/react';
import { finishTour } from '../../services/onboarding.ts';
import { useAuth, usePermissions, useSession } from '../auth/AuthContext.tsx';
import { switchedOff } from '../../app/navigation.ts';
import { tourSteps } from './tour-steps.ts';

/**
 * The guided tour of the console (owner request, 2026-11-16): shown once at a
 * new user's first sign-in, and again whenever they choose it from the help
 * menu. Only the areas their role can open are included. Finishing or skipping
 * is saved, so it does not come back by itself.
 */
export function ConsoleTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useAuth();
  const { user, playground } = useSession();
  const { set } = usePermissions();
  const steps = useMemo<TourStep[]>(
    () => tourSteps(set, user.displayName, switchedOff({ playground })).map((s) => ({ id: s.id, title: s.title, content: s.text, target: s.target, placement: s.placement })),
    [set, user.displayName, playground],
  );

  const end = (outcome: 'COMPLETED' | 'SKIPPED') => {
    onClose();
    // Saved quietly: a failure only means the tour may be offered again at the next sign-in.
    void finishTour(outcome).then(() => refresh()).catch(() => {});
  };

  return (
    <Tour
      steps={steps}
      open={open}
      onFinish={() => end('COMPLETED')}
      onSkip={() => end('SKIPPED')}
      aria-label="Guided tour of the console"
      // Targets are already on the page (the tour never navigates); a missing one (a collapsed sidebar on a phone) is centred quickly.
      targetTimeout={300}
      labels={{ finish: 'Start using ClawRouter' }}
    />
  );
}
