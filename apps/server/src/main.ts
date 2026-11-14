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

  let stopping = false;
  const shutdown = async (reason: string, code: number) => {
    if (stopping) return;
    stopping = true;
    log.info('shutdown requested', { component: 'server', reason });
    // The drain has its own deadline; this one only catches a stop that hangs.
    const force = setTimeout(() => {
      log.fatal('shutdown did not finish in time; exiting', { component: 'server' });
      process.exit(1);
    }, (config.server.shutdownGraceSeconds + 15) * 1000);
    try {
      await app.stop();
    } catch (error) {
      log.error('error while stopping', { component: 'server', error });
      code = 1;
    }
    clearTimeout(force);
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown('SIGINT', 0));
  process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
  // A bug must not leave a half-working gateway behind: log it, drain what is running, exit non-zero
  // so the supervisor (systemd, Docker) starts a fresh process.
  process.on('uncaughtException', (error) => {
    log.fatal('uncaught exception', { component: 'server', error });
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (error) => {
    log.fatal('unhandled promise rejection', { component: 'server', error });
    void shutdown('unhandledRejection', 1);
  });
} catch (error) {
  log.fatal('failed to start', { component: 'server', error });
  process.exit(1);
}
