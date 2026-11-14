# Configuration

ClawRouter reads its configuration from environment variables when it starts
(`packages/core/src/config.ts`). An invalid value stops the start with a message
naming the variable. Some of these values are only **defaults**: a value an
administrator sets in **Administration → Settings** wins until it is reset (see
[administration](administration.md)). Deploying is described in
[deployment](deployment.md).

At start, ClawRouter logs one `configuration` line: database, migration mode, HTTPS,
secure cookies, number of trusted proxies, where the secret key comes from, and the
log level. It never logs a secret.

## Environment

| Variable | Default | |
|---|---|---|
| `CLAWROUTER_ENV` | `production` if `NODE_ENV=production`, else `development` | `production`, `development` or `test`. Production requires a secret key, marks cookies Secure, logs JSON and backs up daily. |

## Server

| Variable | Default | |
|---|---|---|
| `CLAWROUTER_HOST` | `127.0.0.1` | Address to listen on. `0.0.0.0` in the container image. |
| `CLAWROUTER_PORT` | `8080` | `0` picks a free port. |
| `CLAWROUTER_TLS_CERT_FILE`, `CLAWROUTER_TLS_KEY_FILE` | none | PEM certificate (full chain) and private key: ClawRouter serves HTTPS itself. Both or neither. Turns on Secure cookies unless `CLAWROUTER_COOKIE_SECURE` says otherwise. Restart after renewing the certificate. |
| `CLAWROUTER_TRUSTED_PROXIES` | none | Comma-separated addresses or CIDR ranges of reverse proxies. `X-Forwarded-For` is read only from these; the right-most untrusted hop is the client. |
| `CLAWROUTER_SHUTDOWN_GRACE_SECONDS` | `30` (0–600) | How long a stop waits for requests in flight. The process exits regardless 15 seconds after that. |
| `CLAWROUTER_REUSE_PORT` | `false` | Lets a new process bind the port while the old one drains (Linux), for restarts without refused connections. |
| `CLAWROUTER_CONSOLE_ENABLED` | `true` | `false` serves only the APIs (`/api`, `/v1`). |

## Database and backups

| Variable | Default | |
|---|---|---|
| `CLAWROUTER_DATABASE_PATH` | `./data/clawrouter.db` (`:memory:` in tests) | SQLite file. Its directory also holds `setup-token`, the development `secret.key`, the `.pid` file and, by default, `backups/`. |
| `CLAWROUTER_MIGRATIONS` | `auto` | `auto` applies pending migrations at start; `manual` refuses to start until `bun run migrate` has applied them. |
| `CLAWROUTER_BACKUP_BEFORE_MIGRATE` | `true` (on a file database) | Back up before applying migrations, at start or with `bun run migrate`. |
| `CLAWROUTER_BACKUP_DIR` | `<database directory>/backups` | Where backups go. |
| `CLAWROUTER_BACKUP_INTERVAL_HOURS` | `24` in production, else `0` (0–720) | Scheduled backups while running; `0` turns them off. |
| `CLAWROUTER_BACKUP_KEEP` | `7` (1–1000) | Automatic backups kept per kind (scheduled, pre-migrate, pre-import). Manual backups are kept until `bun run backup --keep N`. |

## Secrets

| Variable | Default | |
|---|---|---|
| `CLAWROUTER_SECRET_KEY` | none | Base64 key (32 bytes, `openssl rand -base64 32`) encrypting provider API keys, the mail password and authenticator-app secrets. |
| `CLAWROUTER_SECRET_KEY_FILE` | none | The same key read from a file (preferred: it stays out of the process environment). One of the two is required in production; in development `data/secret.key` is generated. |
| `CLAWROUTER_NEW_SECRET_KEY` | none | Only for `bun run rotate-secret-key`. |
| `CLAWROUTER_SETUP_TOKEN` | generated | One-time token for creating the first administrator at `/setup` (16+ characters). If unset, one is written to `setup-token` next to the database. |

Losing the key loses every stored secret: see [deployment](deployment.md#the-secret-key).

## Sessions

| Variable | Default | |
|---|---|---|
| `CLAWROUTER_SESSION_IDLE_MINUTES` | `60` | Console sign-out after inactivity. A setting. |
| `CLAWROUTER_SESSION_MAX_HOURS` | `12` | Longest console session. A setting. |
| `CLAWROUTER_COOKIE_SECURE` | `true` in production or with TLS | Session cookies only over HTTPS (`__Host-` prefix). Leave it on unless testing over plain HTTP. |

## Logging

| Variable | Default | |
|---|---|---|
| `CLAWROUTER_LOG_LEVEL` | `debug` in development, else `info` | `debug`, `info`, `warn`, `error`. |
| `CLAWROUTER_LOG_FORMAT` | `pretty` in development, else `json` | One JSON object per line on stdout in production. |
| `CLAWROUTER_LOG_BUFFER_SIZE` | `5000` | Recent records kept in memory for the Logs page. |

## Retention and checks

| Variable | Default | |
|---|---|---|
| `CLAWROUTER_REQUEST_RETENTION_DAYS` | `30` | Request history. A setting. |
| `CLAWROUTER_USAGE_RETENTION_DAYS` | `400` | Hourly usage. A setting. |
| `CLAWROUTER_HEALTH_INTERVAL_SECONDS` | `30` | System health checks. |
| `CLAWROUTER_HEALTH_HISTORY_DAYS` | `7` | Health history kept. |
| `CLAWROUTER_PROVIDER_HEALTH_INTERVAL_SECONDS` | `300` | Provider checks; `0` turns them off. |

A full example for a server is in [`deploy/clawrouter.env.example`](../deploy/clawrouter.env.example).

## Configuration export and import

Everything administrators configure in the console (providers, models, routing,
rate limits, custom roles and settings, including the mail server and sign-in
policy) can be exported as one JSON file: **Settings → Configuration**, or
`GET /api/configuration/export` (`settings.read`). Use it to copy a setup to another
server or to keep it under version control.

- **No secrets.** Provider API keys and the mail password are never exported. After
  an import, the result lists what still needs a key.
- **Preview first.** `POST /api/configuration/import/preview` (`settings.write`)
  returns each change (create, update, unchanged, skipped) without applying it.
- **Merge, never delete.** Items are matched by identifier (provider identifier,
  `provider/model`, alias name, role name). Items missing from the file stay.
- **Safe for keys.** A provider whose endpoint moves to another host keeps its old
  endpoint (skipped with a note), so a stored key never goes to a new host; change
  it by hand and enter the key again.
- **No escalation.** Importing a role with permissions you do not hold is refused
  as a whole.
- **Backup.** `POST /api/configuration/import` backs up the database first and
  reports where. Each change is audited (`CONFIGURATION_IMPORTED`, plus the usual
  records of each item); exports are audited too.
- Users, API keys, sessions, request history and audit records are not part of it:
  that is what backups are for.
