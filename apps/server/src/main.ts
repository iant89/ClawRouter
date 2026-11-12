import { createLogger, loadConfig, AppError } from '@clawapi/core';
import consoleHtml from '@clawapi/console/index.html';
import { startClawApi } from './server.ts';
import { VERSION } from './version.ts';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof AppError ? error.message : error);
  process.exit(1);
}

const log = createLogger({ level: config.log.level, format: config.log.format });

try {
  const app = await startClawApi({ config, log, version: VERSION, consoleHtml });

  const shutdown = async (signal: string) => {
    log.info('shutdown requested', { component: 'server', signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    await app.stop();
    clearTimeout(force);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
} catch (error) {
  log.fatal('failed to start', { component: 'server', error });
  process.exit(1);
}
