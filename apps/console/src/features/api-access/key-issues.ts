import { ApiClientError } from '../../services/api-client.ts';

const FIELD: Record<string, string> = {
  name: 'Name', allowedModels: 'Allowed models', expiry: 'Expiry', expiresAt: 'Expiry', rateLimit: 'Rate limit', purpose: 'Purpose', note: 'Note', reason: 'Reason',
};

/** "Expiry must be at most 7 days from now: …" from the server's field issues, for key dialogs. */
export function describeKeyError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.issues.length) {
    return err.issues.map((i) => `${FIELD[i.path.split('.')[0]!] ?? i.path} ${i.message}.`).join(' ');
  }
  return err instanceof Error ? err.message : fallback;
}
