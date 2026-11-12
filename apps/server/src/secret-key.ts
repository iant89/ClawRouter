import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createSecretBox, generateSecretKey, parseSecretKey, type Config, type Logger, type SecretBox } from '@clawapi/core';

/**
 * Loads the key that encrypts stored credentials (spec §29: external to the
 * database). Order: CLAWAPI_SECRET_KEY, CLAWAPI_SECRET_KEY_FILE, then, outside
 * production only, a generated `secret.key` next to the database (mode 0600).
 * Production refuses to start without an explicit key (enforced by config).
 */
export function loadSecretBox(config: Config, log: Logger): SecretBox {
  let text: string;
  if (config.secrets.key) {
    text = config.secrets.key;
  } else if (config.secrets.keyFile) {
    text = readFileSync(config.secrets.keyFile, 'utf8');
  } else if (config.database.path === ':memory:') {
    text = generateSecretKey();
    log.warn('using a temporary secret key: stored credentials will not survive a restart', { component: 'secrets' });
  } else {
    const file = join(dirname(resolve(config.database.path)), 'secret.key');
    if (!existsSync(file)) {
      writeFileSync(file, `${generateSecretKey()}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      log.warn('generated a development secret key; back it up, or credentials cannot be decrypted. Set CLAWAPI_SECRET_KEY in production', { component: 'secrets', file });
    }
    text = readFileSync(file, 'utf8');
  }
  const box = createSecretBox(parseSecretKey(text));
  log.info('secret key loaded', { component: 'secrets', fingerprint: box.fingerprint });
  return box;
}
