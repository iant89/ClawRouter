/**
 * Runs the production bundle built by `bun run build`.
 *
 * Bun resolves the bundled console assets relative to the working directory,
 * so the server runs from dist/. Relative paths in the environment (e.g.
 * CLAWROUTER_DATABASE_PATH) are resolved against the project root first so they
 * mean the same thing as in development.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'main.js'))) {
  console.error('dist/main.js not found. Run `bun run build` first.');
  process.exit(1);
}

const dbPath = process.env.CLAWROUTER_DATABASE_PATH ?? './data/clawrouter.db';
const env = {
  ...process.env,
  CLAWROUTER_ENV: process.env.CLAWROUTER_ENV ?? 'production',
  CLAWROUTER_DATABASE_PATH: dbPath === ':memory:' || isAbsolute(dbPath) ? dbPath : resolve(root, dbPath),
};

const child = Bun.spawn(['bun', 'main.js'], { cwd: dist, env, stdio: ['inherit', 'inherit', 'inherit'] });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
