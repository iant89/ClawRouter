import { useMemo } from 'react';
import { Tour, type TourStep } from '@enterprise-ui/react';
import { finishTour } from '../../services/onboarding.ts';
import { useAuth, usePermissions, useSession } from '../auth/AuthContext.tsx';
import { tourSteps } from './tour-steps.ts';

/**
 * The guided tour of the console (owner request, 2026-11-16): shown once at a
 * new user's first sign-in, and again whenever they choose it from the help
 * menu. Only the areas their role can open are included. Finishing or skipping
 * is saved, so it does not come back by itself.
 */
export function ConsoleTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useAuth();
  const { user } = useSession();
  const { set } = usePermissions();
  const steps = useMemo<TourStep[]>(
    () => tourSteps(set, user.displayName).map((s) => ({ id: s.id, title: s.title, content: s.text, target: s.target, placement: s.placement })),
    [set, user.displayName],
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
      labels={{ finish: 'Start using ClawRouter' }}
    />
  );
}
