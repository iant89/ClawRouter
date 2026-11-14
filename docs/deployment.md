# Deployment

Running ClawRouter on a server: build, install (systemd or Docker), HTTPS, restarts
and upgrades, backups, the secret key, recovery, and monitoring. Every variable is
listed in [configuration](configuration.md). Files referred to here are in
[`deploy/`](../deploy/).

## Requirements

- Linux (macOS works for testing). Bun 1.4 to run the build; nothing else at run time.
- A persistent directory for the database (SQLite) and backups.
- One process per database: ClawRouter is a single node today (rate-limit counters,
  live events and the settings cache are in memory). Run one instance and restart it
  quickly, rather than several behind a load balancer.
- HTTPS in front of it, or its own certificate (below).

## Build

```bash
bun install --frozen-lockfile
bun run build          # dist/: server, console, and the maintenance commands in dist/cli
```

`dist/` is self-contained. It must run with `dist/` as the working directory:

```bash
cd dist && bun main.js
```

Maintenance commands in a deployed `dist/` run as `bun cli/<name>.js` (for example
`bun cli/backup.js`), with the same environment as the server. From a source
checkout they are `bun run <name>`. Both forms are used below.

## The first start

1. Generate the secret key and keep a copy **apart from** the server and its backups
   (a password manager or secrets store):
   ```bash
   openssl rand -base64 32 > /etc/clawrouter/secret.key && chmod 600 /etc/clawrouter/secret.key
   ```
2. Start ClawRouter. Unless `CLAWROUTER_SETUP_TOKEN` is set, it writes a one-time
   token to `setup-token` next to the database and logs where.
3. Open the console at `/setup`, enter the token, and create the administrator.
4. Run `doctor` (below) and fix what it reports.

## systemd

[`deploy/clawrouter.service`](../deploy/clawrouter.service) runs the build from
`/opt/clawrouter/dist` as an unprivileged `clawrouter` user, with only
`/var/lib/clawrouter` writable.

```bash
sudo useradd --system --home /var/lib/clawrouter --shell /usr/sbin/nologin clawrouter
sudo install -d -o clawrouter -g clawrouter -m 700 /var/lib/clawrouter
sudo install -d -m 755 /etc/clawrouter
sudo cp deploy/clawrouter.env.example /etc/clawrouter/clawrouter.env   # edit it
sudo chown clawrouter /etc/clawrouter/secret.key
sudo cp -r dist /opt/clawrouter/
sudo cp deploy/clawrouter.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now clawrouter
journalctl -u clawrouter -f
```

Maintenance commands then run as the service user with its environment, for example:

```bash
cd /opt/clawrouter/dist && sudo -u clawrouter env $(grep -v '^#' /etc/clawrouter/clawrouter.env | xargs) bun cli/doctor.js
```

## Docker

The [`Dockerfile`](../Dockerfile) builds the bundle and runs it as the `bun` user
(uid 1000), with the database on the `/data` volume. Its health check uses the
readiness probe. Behind a TLS-inspecting proxy, pass its certificate authority to
the build: `docker build --secret id=ca,src=/path/ca.pem .`

With Compose ([`deploy/compose.yaml`](../deploy/compose.yaml)):

```bash
cd deploy
openssl rand -base64 32 > secret.key && sudo chown 1000:1000 secret.key && chmod 600 secret.key
docker compose up -d --build
docker compose exec clawrouter cat /data/setup-token
docker compose exec clawrouter bun cli/doctor.js
docker compose exec clawrouter bun cli/backup.js
```

The key file must belong to uid 1000: Compose mounts it into the container as it
is, and the `bun` user has to read it. The port is published on `127.0.0.1` only,
for a proxy on the same host.

## HTTPS

Console sessions and API keys must not cross the network in clear text. Choose one:

- **Caddy** ([`deploy/Caddyfile`](../deploy/Caddyfile)): gets and renews the
  certificate itself. Simplest.
- **nginx** ([`deploy/nginx.conf`](../deploy/nginx.conf)): certificates from
  certbot or elsewhere. Keep `proxy_set_header Host $http_host;` (not `$host`, which
  drops a non-standard port and makes the console's same-origin checks refuse
  requests), the WebSocket upgrade headers (the live channel at `/api/ws`), and
  `proxy_buffering off` (streamed responses).
- **ClawRouter itself**: set `CLAWROUTER_TLS_CERT_FILE` and `CLAWROUTER_TLS_KEY_FILE`.
  Restart after renewing; `doctor` warns three weeks before the certificate expires.

Behind a proxy, set `CLAWROUTER_TRUSTED_PROXIES` to the proxy's address
(`127.0.0.1` on the same host; the Docker network range with Compose). Otherwise
every request appears to come from the proxy, and the sign-in and invalid-key limits
per address would lock everyone out together. Leave `CLAWROUTER_COOKIE_SECURE` on.
With Secure cookies on, ClawRouter also sends `Strict-Transport-Security`.

## Stopping, restarting and upgrading

On `SIGTERM` or `SIGINT` ClawRouter **drains**: the readiness probe answers 503, new
`/v1` requests get 503 with `Retry-After: 5`, and requests already running (streams
included) may finish for `CLAWROUTER_SHUTDOWN_GRACE_SECONDS` (30). Then it closes
the database and exits with 0. Give the service manager more time than that
(`TimeoutStopSec=45`, `stop_grace_period: 45s`). An uncaught error also leads to a
drained stop, with exit code 1, so the service manager restarts it.

With `CLAWROUTER_REUSE_PORT=true` (Linux), a new process can start on the same port
while the old one drains, so no connection is refused during a restart: start the
new one, wait for `/api/health/ready`, then stop the old one.

**Upgrading:**

1. `bun cli/backup.js` (or rely on the automatic pre-migration backup).
2. Replace `dist/` with the new build and restart.
3. Pending migrations run at start, after a backup into `backups/` labeled
   `pre-migrate` (`CLAWROUTER_BACKUP_BEFORE_MIGRATE`). With `CLAWROUTER_MIGRATIONS=manual`,
   ClawRouter refuses to start until you run `bun cli/migrate.js`
   (`--status` lists them).
4. A console left open across the upgrade offers to reload.

Migrations only move forward. To go back to an older version, restore the backup made
before the upgrade: an older ClawRouter refuses a database from a newer one.

## Backups

A backup is a directory with a consistent copy of the database (`VACUUM INTO`, safe
while ClawRouter runs) and a `manifest.json` (checksum, version, migrations, key
fingerprint). Directories are created with mode 0700, files 0600.

- **Scheduled**: every `CLAWROUTER_BACKUP_INTERVAL_HOURS` (24 in production) into
  `CLAWROUTER_BACKUP_DIR`; the newest `CLAWROUTER_BACKUP_KEEP` (7) are kept.
- **Automatic**: before migrations and before a configuration import.
- **Manual**: `bun cli/backup.js` (`--dir`, `--keep N`, `--list`).

The **secret key is not in a backup** unless you add `--include-secret-key`: whoever
holds both can read every provider API key. Keep the key separately, and copy
backups off the machine (they sit on the same disk as the database by default).

**Restore** (ClawRouter stopped):

```bash
bun cli/restore.js /var/lib/clawrouter/backups/clawrouter-20261114-020000-scheduled          # checks, says what it would do
bun cli/restore.js /var/lib/clawrouter/backups/clawrouter-20261114-020000-scheduled --yes
```

It verifies the checksum, refuses a backup from a newer version, and refuses one
whose secrets the configured key cannot open (`--force` restores anyway; those
values are then entered again). The current database is kept as
`<database>.before-restore-<time>`. Restored databases are migrated forward, and the
restore is audited.

## The secret key

Provider API keys, the mail server password and authenticator-app secrets are
encrypted with it. Store it in a file readable only by ClawRouter
(`CLAWROUTER_SECRET_KEY_FILE`), and a second copy somewhere else.

**Rotating** (for example when someone who saw it leaves): stop ClawRouter, back up,
then

```bash
openssl rand -base64 32 > new.key
bun cli/rotate-secret-key.js --new-key-file new.key
```

Every encrypted value is re-encrypted in one transaction. Configure the new key,
start, and make a new backup: older backups still need the old key, so keep it until
they expire. `doctor` warns when the newest backup was made with another key.

## Recovery

| What is lost | Do this |
|---|---|
| An administrator's password | `bun cli/reset-password.js <username>` prints a temporary password, which must be changed at the next sign-in. `--enable` also re-enables the account. |
| An administrator's authenticator app | `bun cli/reset-password.js <username> --reset-2fa` (other administrators can reset it in the console). Recovery codes also work. |
| The secret key, with a copy elsewhere | Configure the copy. Nothing is lost. |
| The secret key, for good | `bun cli/clear-credentials.js` lists what the configured key cannot open; `--yes` forgets those values, which are then entered again (provider keys, mail password; users set up their authenticator app again). Everything else stays. |
| The database | Restore the latest backup. |
| A broken configuration change | Restore the backup taken before an import, or fix it in the console; audit records show what changed. |

All of these run on the server only. There is no password reset by email.

## Checking a deployment

```bash
bun cli/doctor.js          # ✔ ok · ! warning · ✖ error, each with what to do
bun cli/doctor.js --json   # for monitoring; exits 1 when something is wrong
```

It changes nothing. It checks the environment, the secret key (and its file
permissions), the database's integrity, pending or unknown migrations, whether every
encrypted value opens with the key, whether the server runs, HTTPS (certificate
expiry), cookies, the age of the newest backup, and free disk space.

## Health probes

| Endpoint | Access | |
|---|---|---|
| `GET /api/health/live` | public | 200 while the process answers. For restarting a hung process. |
| `GET /api/health/ready` | public | 200 when it accepts new work; 503 while it drains for a stop or restart. For load balancers and container health checks. |
| `GET /api/health` | public | Overall status; details and latencies only for users with `health.read`. |

## Logging

In production ClawRouter logs JSON lines on stdout (journald or the container log
are the log of record). Secrets are redacted by field name and scrubbed by shape.
The console's **Logs** page shows the last `CLAWROUTER_LOG_BUFFER_SIZE` records
from memory; **Audit** is stored in the database and is part of backups.
