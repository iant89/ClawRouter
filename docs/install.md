# Installing on Ubuntu 24.04

One command installs ClawRouter as the sandboxed systemd service described in
[deployment](deployment.md#systemd):

```bash
curl -fsSL https://raw.githubusercontent.com/iant89/ClawRouter/main/deploy/install.sh | sudo bash
```

With a domain name that points at the server, Caddy serves it over HTTPS (certificate from
Let's Encrypt; ports 80 and 443 must reach the server):

```bash
curl -fsSL https://raw.githubusercontent.com/iant89/ClawRouter/main/deploy/install.sh | sudo bash -s -- --domain gateway.example.com
```

Prefer to read it first? Download, read, then run:

```bash
curl -fsSLO https://raw.githubusercontent.com/iant89/ClawRouter/main/deploy/install.sh
less install.sh
sudo bash install.sh --domain gateway.example.com
```

## What it does

| Step | |
|---|---|
| 1. Checking the system | Ubuntu 24.04, x86_64 or arm64 (picks Bun's baseline build on CPUs without AVX2), systemd, 1 GB free, the port free; asks for confirmation |
| 2. System packages | `ca-certificates curl git unzip openssl` (and `caddy` with `--domain`) from Ubuntu's archive. On a freshly booted server Ubuntu installs its security updates first and holds the package lock: the installer says so and waits (up to 20 minutes) instead of failing |
| 3. Bun | the version the Docker image uses, downloaded from Bun's GitHub release and **checked against a SHA-256 written in the script**; anything else stops the install |
| 4. Source | a shallow clone of `main` (or `--ref`) into `/opt/clawrouter/src` |
| 5. Build | `bun install --frozen-lockfile` (every package checked against `bun.lock`) and `bun run build` |
| 6. Account, settings, key | the `clawrouter` system account, `/var/lib/clawrouter` (0700), `/etc/clawrouter/clawrouter.env` (0600, from `deploy/clawrouter.env.example`) and a new `/etc/clawrouter/secret.key` (0600) |
| 7. Service | the build into `/opt/clawrouter/dist` (root-owned, read-only for the service), `deploy/clawrouter.service`, enabled at boot, started, waited on until `/api/health/ready` answers |
| 8. HTTPS (`--domain`) | `/etc/caddy/Caddyfile` from `deploy/Caddyfile` (a previous one is kept as `Caddyfile.before-clawrouter`); ports 80/443 opened only if `ufw` is already active |
| 9. Checking | `doctor` and `doctor --security`; warnings and failures are listed |

At the end it shows the console address, the **one-time setup token** for `/setup`, and a
reminder to copy the secret key somewhere safe (a password manager): without it, stored provider
keys and backups cannot be read.

Each running step shows a spinner and the time it has taken so far, so a long build or download
never looks frozen; finished steps that took 2 seconds or more show their time. The screen shows only the steps; every command's output goes to
`/var/log/clawrouter-install.log` (0600). A failed step shows the end of that log.

## Options

| Option | |
|---|---|
| `--domain <name>` | HTTPS through Caddy for that name |
| `--port <number>` | the local port (default 8080, always on 127.0.0.1) |
| `--ref <branch or tag>` | what to install (default `main`) |
| `--yes`, `-y` | no confirmation (needed without a terminal: cron, CI, `ssh` without `-t`) |
| `--force` | continue on another Ubuntu version |

## Upgrading

Run the same command again. It keeps the secret key, the settings file and the database, makes a
backup with `bun cli/backup.js` while the old version still runs, swaps in the new build, and
restarts; migrations run at start (and back up first, too).

## Without a domain

ClawRouter listens on 127.0.0.1 only. From your own computer:

```bash
ssh -L 8080:127.0.0.1:8080 you@server     # then open http://localhost:8080
```

## If it seems stuck

Watch what the current step is doing from a second terminal:

```bash
sudo tail -f /var/log/clawrouter-install.log
```

The longest steps are the automatic-updates wait on a new server and the build on a small one
(1 vCPU, 1 GB RAM can take a few minutes; `free -m` shows whether memory ran out).

## Tested

On Ubuntu 24.04 with systemd 255 (booted in a container, 2026-11-21): a fresh install (16 of 16
security checks passed), an upgrade with `--domain` (data and key kept, backup made, Caddy
redirecting to https), and a busy package manager (the wait step, then the install), and the failure paths: no terminal without `--yes`, not root, hostile
`--domain`/`--port`/`--ref` values, and a Bun download that does not match its hash (stopped,
nothing installed). Let's Encrypt itself was not reached (no public name), and the script was
run from a copy, not yet through the `raw.githubusercontent.com` URL. Tests:
`tests/security/host/install-script.test.ts`.
