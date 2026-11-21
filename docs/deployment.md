# Deployment

Running ClawRouter on a server: build, install (systemd or Docker), HTTPS, restarts
and upgrades, backups, the secret key, recovery, and monitoring. Every variable is
listed in [configuration](configuration.md). Files referred to here are in
[`deploy/`](../deploy/).

**Ubuntu 24.04:** [`deploy/install.sh`](../deploy/install.sh) does everything below in one command
(systemd service, optional Caddy HTTPS, checks): see [installing on Ubuntu](install.md).

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
sudo chmod 600 /etc/clawrouter/clawrouter.env   # systemd reads it as root; it may hold the setup token
sudo chown clawrouter /etc/clawrouter/secret.key
sudo cp -r dist /opt/clawrouter/
sudo cp deploy/clawrouter.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now clawrouter
journalctl -u clawrouter -f
```

Maintenance commands then run as the service user with its environment, for example:

```bash
cd /opt/clawrouter/dist && sudo -u clawrouter env $(sudo grep -v '^#' /etc/clawrouter/clawrouter.env | xargs) bun cli/doctor.js
```

### systemd hardening

The unit runs ClawRouter in a sandbox (SEC-024). `systemd-analyze security clawrouter.service`
rates it **1.1 OK** (the unit without these directives: 7.7 EXPOSED). Every directive was run
with the production build under systemd 255 (setup, sign-in, providers by host name, chat,
streams, the live channel, health checks, backups, HTTPS with a root-owned key, `doctor`,
a SIGTERM drain), and the server's `/proc` status showed no capabilities, no-new-privileges
and a seccomp filter.

| What | Directives | Effect |
|---|---|---|
| Writable files | `StateDirectory=clawrouter` (0700), `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `UMask=0077` | Only `/var/lib/clawrouter` (database, backups, setup token) can be written; `/opt`, `/etc` and `/usr` are read-only, home directories hidden, `/tmp` and `/dev` private |
| Kernel | `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname` | No sysctl, module, kernel log, clock, hostname or cgroup changes |
| Other processes | `ProtectProc=invisible`, `ProcSubset=pid`, `PrivateIPC`, `RemoveIPC` | It sees only its own processes |
| Privileges | `NoNewPrivileges`, `CapabilityBoundingSet=` (empty), `AmbientCapabilities=`, `PrivateUsers`, `RestrictSUIDSGID`, `LockPersonality`, `RestrictRealtime`, `RestrictNamespaces` | Nothing to gain or keep; only the service account and an unprivileged root exist in its user namespace |
| Network and system calls | `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `SystemCallArchitectures=native`, `SystemCallFilter=@system-service ~@privileged @resources` | No raw, packet or netlink sockets; system calls outside a network service's set fail with EPERM |

Left off on purpose: `MemoryDenyWriteExecute=true` takes away the JavaScript engine's
just-in-time compiler (Bun still starts, but ran a test loop 2.7 times slower);
`PrivateNetwork` and `IPAddressDeny` would cut ClawRouter off from its providers (the
[outbound policy](security.md#outbound-network-policy) decides where they may be).

Changes go in a drop-in (`sudo systemctl edit clawrouter`), not in the unit:

- **A database or backup directory outside `/var/lib/clawrouter`**: `ReadWritePaths=/that/directory`.
- **Listening on 80 or 443 directly** (without a reverse proxy):
  `AmbientCapabilities=CAP_NET_BIND_SERVICE`, `CapabilityBoundingSet=CAP_NET_BIND_SERVICE` and
  `PrivateUsers=false`. Inside the user namespace the capability does not reach the host's
  ports (checked: with `PrivateUsers=true` port 443 is refused even with the capability).
- **A TLS key** readable by the service: `root:clawrouter` and mode 0640 works with the sandbox.

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

### Container hardening

The Compose file runs ClawRouter so that a compromised process stays inside its
container (SEC-004): the unprivileged `bun` user, a **read-only root
filesystem** (only the `/data` volume and a small `noexec` tmpfs on `/tmp` are
writable), **all Linux capabilities dropped**, `no-new-privileges`, a process
limit and a memory limit. Docker's default seccomp and AppArmor (or SELinux)
profiles stay on. Never add `privileged`, `network_mode: host`, `pid: host`,
`seccomp=unconfined` or a mount of `/var/run/docker.sock`. Without Compose, the
same flags:

```bash
docker run -d --name clawrouter -p 127.0.0.1:8080:8080 \
  --user 1000:1000 --read-only --tmpfs /tmp:size=64m,mode=1777,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 256 --memory 1g \
  -v clawrouter-data:/data -v "$PWD/secret.key:/run/secrets/clawrouter_key:ro" \
  -e CLAWROUTER_SECRET_KEY_FILE=/run/secrets/clawrouter_key clawrouter
```

Checked on 2026-11-19 (Docker 29.10): the server starts and passes readiness; in
the container the process is uid 1000 with empty capability sets
(`CapEff/CapPrm/CapBnd` 0), `NoNewPrivs: 1`, seccomp in filter mode, and writes
to `/app/dist` or `/etc` fail with "Read-only file system". The image sets
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` so Bun never tries to write a cache.

A local model server on the same Compose network (e.g. an `ollama` service)
must be named in `CLAWROUTER_OUTBOUND_ALLOWLIST` (see
[security](security.md#outbound-network-policy)).

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

A **normal backup** is the database: the whole configuration (providers, models, routing,
limits, roles, settings) and the operational data (users, API keys as hashes, audit, usage,
request history). Stored credentials (provider keys, the mail password, authenticator secrets)
are in it **only encrypted**; the **secret key is not**. Whoever holds both can read every
provider API key, so keep the key separately, and copy backups off the machine (they sit on
the same disk as the database by default). Environment variables are not in a backup.

A **credential backup** (SEC-011) also holds the secret key, so it opens everything on its own:

```bash
bun cli/backup.js --include-secret-key           # warns, then asks you to type "include the secret key"
bun cli/backup.js --include-secret-key --yes     # without a terminal (scripts): --yes is the confirmation
bun cli/backup.js --list --credentials           # lists them (never the key; only its fingerprint)
```

It is written to `<backup dir>/credentials/` (directory 0700, re-applied if it was wider; files
0600) as `clawrouter-<time>-credentials`, audited as `CREDENTIAL_BACKUP_CREATED`, and never
shown by `--list`, pruned by `--keep` or scheduled backups, or deleted automatically: delete
it yourself when it is no longer needed. It restores like any other backup. `doctor` warns
about backups with the key among normal ones (made before this separation: move them) and
about a credentials directory other users can read.

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

A backup directory is treated as untrusted: its database is copied once into a
private folder next to the live database (so restore needs free space there for
one copy), and every check runs on that copy before the same file is moved into
place. Symbolic links are refused, the manifest is validated, and the schema
must be exactly what ClawRouter's migrations create (a database with an extra
trigger or table is refused). See [SEC-003](security-roadmap.md).

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
bun cli/doctor.js                          # ✔ ok · ! warning · ✖ error, each with what to do
bun cli/doctor.js --json                   # for monitoring; exits 1 when something is wrong
bun cli/doctor.js --fix                    # also repair what it safely can (asks first)
bun cli/doctor.js --fix --yes              # the same without asking, e.g. from cron
bun cli/doctor.js --fix --clear-unreadable # also forget values the key cannot open
bun cli/doctor.js --security               # the security check (below)
```

Without `--fix` it changes nothing. It checks the environment, the secret key (and
its file permissions), the [permissions and owners](#file-permissions) of ClawRouter's files, the database's integrity, pending or unknown migrations,
whether every encrypted value opens with the key, whether the server runs, HTTPS
(certificate expiry), cookies, the age of the newest backup, and free disk space.

With `--fix` it lists the repairs it can make, asks (`--yes` skips the question;
without a terminal and without `--yes` it changes nothing), applies them one by one,
then checks everything again and prints the result:

| Problem | Repair |
|---|---|
| A process-ID file left by a crash | Removes it |
| The key file is readable by other users | `chmod 600` |
| ClawRouter's files or directories allow group or other users ([file permissions](#file-permissions)) | Removes those permissions (0600 / 0700; the TLS key keeps 0640). Symbolic links are never followed |
| No backup, or the newest is overdue | Takes a backup now (a manual one; older manual backups are kept) |
| Pending migrations, server stopped | Backs up (`pre-migrate`), then applies them. Never while the server runs: stop it first |
| Encrypted values the key cannot open | Only with `--clear-unreadable`: backs up (`pre-repair`), then forgets those values, which must be entered again (see [Recovery](#recovery)) |

Anything else (a damaged database, settings that live in environment variables such
as `CLAWROUTER_ENV` or the HTTPS files, low disk space) is reported with what to do,
never changed. Every repair, done or failed, is recorded in the audit log as
`DOCTOR_REPAIR` (by "command line", with the repair and its outcome), and backups and
cleared values also write their own records, as when
done by hand. With `--json`, `--fix --yes` prints `{ before, repairs, after }`.

### The security check

`doctor --security` (SEC-025) reviews the deployment's security instead, as `[PASS]`,
`[INFO]`, `[WARN]` and `[FAIL]` lines; it exits 1 when anything fails. It changes nothing;
`--security --fix` applies the same safe repairs (key and file permissions), and `--json`
works as above. Run it as the service account, like `doctor`.

```text
CLAWROUTER SECURITY CHECK

[PASS] https: HTTPS configured at the reverse proxy; ClawRouter listens on 127.0.0.1 only
[PASS] cookies: secure cookies enabled (Secure, HttpOnly, SameSite=Strict)
[PASS] trusted proxies: trusted proxy configuration valid: 127.0.0.1
[PASS] secret key: secret key permissions: 0600
[PASS] database: database permissions: 0600
[PASS] api keys: API keys hashed (1 key(s), SHA-256 only; session tokens too)
[PASS] credentials: provider credentials encrypted (1 value(s), AES-256-GCM)
[PASS] mcp: MCP disabled
[PASS] process: server running non-root (the server (process 1042): uid 997)
[PASS] process: the server (process 1042): no capabilities, no-new-privileges, system calls filtered (seccomp)
[PASS] csrf: CSRF protection enabled: http://127.0.0.1:8080 refused a cross-site request
[PASS] cors: no wildcard CORS: http://127.0.0.1:8080 sent no CORS headers to a cross-site origin
[WARN] two-factor: two-factor sign-in is not required; 1 of 1 administrator(s) sign in with a password alone
       → Require it for administrators at least: Administration → Settings → Sign-in and sessions → Two-factor sign-in.
```

| Area | FAIL | WARN |
|---|---|---|
| https | Production, plain HTTP on a public interface with no reverse proxy; an expired certificate | Behind a proxy but listening on every interface (the proxy can be bypassed); no `Strict-Transport-Security` on an https `--url` |
| cookies | Session cookies without `Secure` in production or on a public interface | |
| trusted proxies | A catch-all range (`0.0.0.0/0`): any client picks its own address | A wide range (shorter than /16, IPv6 /48) |
| secret key | The key file readable by others | The key in the data or backup directory (SEC-011); `CLAWROUTER_SECRET_KEY` in the environment is INFO |
| database, files, backups | The database or a private file readable by others | A backup or the data directory open to others; backups with the secret key beside ordinary ones |
| api keys, credentials | A key or session token not stored as a SHA-256 hash, a full API key anywhere it is looked for, a credential not encrypted | Encrypted values the configured key cannot open |
| providers | | Plain http to another machine; a catch-all outbound allowlist |
| mcp, request logging, captures | | The MCP server on; request logging Full (prompt content); provider captures on |
| two-factor, setup token | | Not required while an administrator has none; a setup token left after setup; setup not done on a public interface |
| process | The server (or, in a container, the command) runs as root | Capabilities kept; no-new-privileges off |
| csrf, cors | The running server accepted a cross-site POST; a CORS header allowing any origin with credentials | Other CORS headers |

When the server is running (its process-ID file names a live process), the check also
reads the server's `/proc` status and asks it over loopback: a cross-site `POST` must be
refused, and neither a CORS preflight nor a cross-site `GET` may get an
`Access-Control-Allow-Origin` back. `--url https://clawrouter.example.com` asks the
public address instead, through the reverse proxy, which is where wrong CORS or lost
`Origin` headers come from; it also wants `Strict-Transport-Security` there. A
self-signed certificate does not stop the probe (the certificate is checked from its
file). Not checked: firewall rules, the reverse proxy's own TLS settings, and anything on
other machines.

## File permissions

ClawRouter's files are private to the account it runs as (SEC-023): files **0600**,
directories **0700**, owned by that account.

| Path | Mode | Who makes it private |
|---|---|---|
| The data directory (beside the database) | 0700 | ClawRouter when it creates it; an existing one is the operator's (`doctor` reports it) |
| The database and its `-wal` and `-shm` files | 0600 | ClawRouter: created 0600, and made 0600 at every start if wider (logged) |
| `<database>.pid`, `setup-token` | 0600 | ClawRouter |
| `secret.key` generated in development | 0600 | ClawRouter: created 0600, made 0600 at start if wider |
| `CLAWROUTER_SECRET_KEY_FILE` | 0600 | The operator (`doctor` reports it; `--fix` repairs it) |
| The backup directory, every backup, `credentials/` | 0700, files 0600 | ClawRouter |
| `CLAWROUTER_TLS_KEY_FILE` | 0640 at most (its group may read it, e.g. `ssl-cert`) | The operator |
| The environment file (`/etc/clawrouter/clawrouter.env`) | 0600 | The operator |

- The server and every command-line tool set the **umask to 0077** before they
  start, so whatever they create without an explicit mode (SQLite's temporary files)
  is private too. The systemd unit also sets `UMask=0077`, and the Docker image
  creates `/data` as 0700.
- ClawRouter writes **no log files**: logs go to stdout (journald or Docker keep
  them). Request content (`CLAWROUTER_REQUEST_LOGGING=full`) and provider captures
  are in the database, so they share its mode.
- Run maintenance commands **as the service account** (`sudo -u clawrouter …`), not
  as root: a backup or a migrated database written by root cannot be read by the
  server. `doctor` names files whose owner is not the data directory's owner.
- A deployment that needs a group to read the data (a separate backup account) can
  give that access to a copy (`bun run backup` into a directory it owns), not to the
  live files: ClawRouter removes group permissions from the database at every start.

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
