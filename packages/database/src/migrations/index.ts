import type { Migration } from '../migrations.ts';
import { m0001Settings } from './0001_settings.ts';

/** All migrations, in order. Append only. */
export const migrations: readonly Migration[] = [m0001Settings];
