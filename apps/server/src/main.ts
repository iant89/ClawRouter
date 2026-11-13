import { createLogger, loadConfig, AppError, LogBuffer } from '@clawrouter/core';
import consoleHtml from '@clawrouter/console/index.html';
import { startClawRouter } from './server.ts';
import { VERSION } from './version.ts';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof AppError ? error.message : error);
  process.exit(1);
}

// Recent records also go to an in-memory buffer for the console's Logs page (already redacted).
const logBuffer = config.log.bufferSize > 0 ? new LogBuffer(config.log.bufferSize) : undefined;
const log = createLogger({ level: config.log.level, format: config.log.format, tap: logBuffer?.push });

try {
  const app = await startClawRouter({ config, log, logBuffer, version: VERSION, consoleHtml, consoleDir: import.meta.dir });

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
