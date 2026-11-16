import type { Database } from '@clawrouter/database';
import type { TourState } from '@clawrouter/shared';

/** Each user's guided-tour state (users.tour_state, migration 0020). */
export interface TourRepository {
  get(userId: string): TourState | null;
  set(userId: string, state: TourState): void;
}

export function createSqliteTourRepository(db: Database): TourRepository {
  return {
    get(userId) {
      return db.get<{ tour_state: TourState }>('SELECT tour_state FROM users WHERE id = ?', [userId])?.tour_state ?? null;
    },
    set(userId, state) {
      db.run('UPDATE users SET tour_state = ? WHERE id = ?', [state, userId]);
    },
  };
}
