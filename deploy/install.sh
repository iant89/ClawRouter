#!/usr/bin/env bash
# ClawRouter - Self-hosted AI gateway and control platform
# https://github.com/iant89/ClawRouter
#
# Copyright (C) 2026 Ian Thomas
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it under
# the terms of the GNU Affero General Public License as published by the Free
# Software Foundation, either version 3 of the License, or (at your option) any
# later version. This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
# or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
# in the LICENSE file for more details.

# ClawRouter installer for Ubuntu 24.04 (docs/install.md).
#
#   curl -fsSL https://raw.githubusercontent.com/iant89/ClawRouter/main/deploy/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/iant89/ClawRouter/main/deploy/install.sh | sudo bash -s -- --domain gateway.example.com
#
# It installs Bun (pinned version, checked against a SHA-256 written in this file), builds
# ClawRouter from source, and runs it as the sandboxed systemd service of
# docs/deployment.md#systemd; with --domain, Caddy serves it over HTTPS. Running it again
# upgrades: the secret key, settings and database are kept, and a backup is made first.
# Command output goes to /var/log/clawrouter-install.log.

set -Eeuo pipefail

# --- Settings ---------------------------------------------------------------------------
REPO_URL="https://github.com/iant89/ClawRouter.git"
REF="main"
DOMAIN=""
PORT="8080"
ASSUME_YES=0
FORCE=0
ASCII=0
LAN=0
SKIP_PACKAGES=0

# Bun must match the Dockerfile (tests/security/host/install-script.test.ts checks).
BUN_VERSION="1.4.4"
declare -A BUN_SHA256=(
  [bun-linux-x64]="bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c"
  [bun-linux-x64-baseline]="e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76"
  [bun-linux-aarch64]="baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e"
)

PREFIX="/opt/clawrouter"
SRC_DIR="$PREFIX/src"
DIST_DIR="$PREFIX/dist"
DATA_DIR="/var/lib/clawrouter"
CONF_DIR="/etc/clawrouter"
ENV_FILE="$CONF_DIR/clawrouter.env"
KEY_FILE="$CONF_DIR/secret.key"
UNIT_FILE="/etc/systemd/system/clawrouter.service"
SERVICE_USER="clawrouter"
BUN="/usr/local/bin/bun"
LOG="/var/log/clawrouter-install.log"
TOTAL_STEPS=8

# --- Output -----------------------------------------------------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  BOLD=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' BLUE=$'\e[34m' CYAN=$'\e[36m' RESET=$'\e[0m'
  INTERACTIVE=1
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" CYAN="" RESET=""
  INTERACTIVE=0
fi
STEP=0
CURRENT=""

# Symbols: Unicode on a UTF-8 terminal, plain ASCII elsewhere. Remote consoles (a provider's web
# console, IPMI or serial), the Linux text console and non-UTF-8 locales show Unicode as garbage.
utf8_terminal() {
  case "${TERM:-}" in linux | dumb | vt100 | vt102 | vt220 | ansi) return 1 ;; esac
  [[ "$(locale charmap 2>/dev/null)" == "UTF-8" ]]
}
choose_symbols() {
  if [[ $ASCII -eq 0 ]] && utf8_terminal; then
    SYM_OK='✔' SYM_FAIL='✖' SYM_INFO='•' SYM_WARN='!' SYM_ASK='?' SYM_SEP='·' SYM_MORE='…'
    SPIN_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
    BOX_TL='╭' BOX_TR='╮' BOX_BL='╰' BOX_BR='╯' BOX_H='─' BOX_V='│'
  else
    SYM_OK='[ok]' SYM_FAIL='[!!]' SYM_INFO='-' SYM_WARN='[!]' SYM_ASK='[?]' SYM_SEP='|' SYM_MORE='...'
    SPIN_FRAMES=('|' '/' '-' "\\")
    BOX_TL='+' BOX_TR='+' BOX_BL='+' BOX_BR='+' BOX_H='-' BOX_V='|'
  fi
}

banner() {
  printf '\n%s' "$CYAN$BOLD"
  cat <<'EOF'
   _____ _                 ____             _
  / ____| |               |  _ \           | |
 | |    | | __ ___      __| |_) |___  _   _| |_ ___ _ __
 | |    | |/ _` \ \ /\ / /|  _ </ _ \| | | | __/ _ \ '__|
 | |____| | (_| |\ V  V / | | \ \ (_) | |_| | ||  __/ |
  \_____|_|\__,_| \_/\_/  |_|  \_\___/ \__,_|\__\___|_|
EOF
  printf '%s\n' "$RESET"
  printf '  %sSelf-hosted AI gateway %s installer for Ubuntu 24.04%s\n\n' "$DIM" "$SYM_SEP" "$RESET"
}

step() {
  STEP=$((STEP + 1))
  printf '\n%s[%d/%d]%s %s%s%s\n' "$BLUE$BOLD" "$STEP" "$TOTAL_STEPS" "$RESET" "$BOLD" "$1" "$RESET"
  printf '\n==== [%d/%d] %s\n' "$STEP" "$TOTAL_STEPS" "$1" >>"$LOG"
}
ok()   { printf '  %s%s%s %s\n' "$GREEN" "$SYM_OK" "$RESET" "$1"; }
info() { printf '  %s%s%s %s\n' "$DIM" "$SYM_INFO" "$RESET" "$1"; }
warn() { printf '  %s%s%s %s\n' "$YELLOW" "$SYM_WARN" "$RESET" "$1"; }
fail() {
  printf '\n  %s%s %s%s\n' "$RED$BOLD" "$SYM_FAIL" "$1" "$RESET" >&2
  [[ -n "${2:-}" ]] && printf '    %s\n' "$2" >&2
  [[ -f "$LOG" ]] && printf '    Details: %s\n' "$LOG" >&2
  exit 1
}

# run "what is happening" command...: the command's output goes to the log; the screen shows a
# spinner while it runs, then ✔ or ✖ with the end of the log.
run() {
  local label="$1"
  shift
  CURRENT="$label"
  printf '$ %s\n' "$*" >>"$LOG"
  local started=$SECONDS from progress=""
  from=$(stat -c %s "$LOG")
  if [[ $INTERACTIVE -eq 1 ]]; then
    # The step's own failure is reported here, not by the ERR trap inside the background job.
    ( trap - ERR; "$@" ) >>"$LOG" 2>&1 &
    local pid=$! i=0
    while kill -0 "$pid" 2>/dev/null; do
      # Commands run through run_progress report a percentage: read the newest one twice a second.
      if [[ $SHOW_PROGRESS -eq 1 ]] && ((i % 5 == 0)); then progress=$(progress_since "$from"); fi
      # The time keeps moving, so a long step (a build, a slow download) never looks frozen.
      printf '\r  %s%s%s %s%s %s%s%s\e[K' "$CYAN" "${SPIN_FRAMES[i++ % ${#SPIN_FRAMES[@]}]}" "$RESET" "$label" "${progress:+ $BOLD$progress$RESET}" "$DIM" "$(elapsed "$started")" "$RESET"
      sleep 0.1
    done
    if wait "$pid"; then
      printf '\r\e[2K  %s%s%s %s%s%s%s\n' "$GREEN" "$SYM_OK" "$RESET" "$label" "$DIM" "$(took "$started")" "$RESET"
    else
      printf '\r\e[2K  %s%s%s %s%s%s%s\n' "$RED" "$SYM_FAIL" "$RESET" "$label" "$DIM" "$(took "$started")" "$RESET"
      printf '%s' "$DIM"; tail -n 15 "$LOG" | sed 's/^/      /'; printf '%s' "$RESET"
      fail "Step failed: $label"
    fi
  else
    if ( trap - ERR; "$@" ) >>"$LOG" 2>&1; then ok "$label$(took "$started")"; else tail -n 15 "$LOG" | sed 's/^/      /'; fail "Step failed: $label"; fi
  fi
  CURRENT=""
}

# run_progress: run, showing the percentage the command writes as it goes (git --progress,
# curl --progress-bar). Only for such commands: other output may hold numbers with "%" too.
SHOW_PROGRESS=0
run_progress() {
  SHOW_PROGRESS=1
  run "$@"
  SHOW_PROGRESS=0
}

# The newest progress the log holds after byte $1: "Receiving objects 45%" (git, which counts
# objects, then deltas) or "45%" (curl). Progress lines end in \r, so they are split there.
progress_since() {
  tail -c +"$(($1 + 1))" "$LOG" 2>/dev/null | tr '\r' '\n' \
    | grep -oE '(Counting objects|Compressing objects|Receiving objects|Resolving deltas): +[0-9]{1,3}%|[0-9]{1,3}(\.[0-9])?%$' \
    | tail -n 1 | sed -E 's/: +/ /; s/\.[0-9]%$/%/' || true
}

# "0:42" / "12:05" since $1 (a value of $SECONDS).
elapsed() {
  local s=$((SECONDS - $1))
  printf '%d:%02d' $((s / 60)) $((s % 60))
}
# " (42s)" or " (2m 05s)" for a finished step; nothing for one that took under 2 seconds.
took() {
  local s=$((SECONDS - $1))
  if ((s < 2)); then return; elif ((s < 60)); then printf ' (%ds)' "$s"; else printf ' (%dm %02ds)' $((s / 60)) $((s % 60)); fi
}

on_error() {
  local code=$?
  printf '\n  %s%s The installer stopped unexpectedly%s%s (exit %d).\n' "$RED$BOLD" "$SYM_FAIL" "$RESET" "${CURRENT:+ during: $CURRENT}" "$code" >&2
  printf '    Details: %s\n' "$LOG" >&2
}
trap on_error ERR

# Answers come from the terminal, not stdin: with `curl … | sudo bash`, stdin is this script.
confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  local answer
  # No terminal (cron, CI, ssh without -t): never take silence for a yes.
  if ! { printf '  %s%s%s %s [Y/n] ' "$YELLOW" "$SYM_ASK" "$RESET" "$1" >/dev/tty && read -r answer </dev/tty; } 2>/dev/null; then
    fail "No terminal to ask for confirmation." "Run again with --yes to install without questions."
  fi
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

usage() {
  cat <<EOF
ClawRouter installer for Ubuntu 24.04

Usage: sudo bash install.sh [options]

  --lan             listen on every network interface over plain HTTP (a home or office
                    network without a domain): http://<this server's address>:<port>.
                    Passwords and API keys cross the network unencrypted; not for the internet
  --domain <name>   serve https://<name> through Caddy (certificate from Let's Encrypt;
                    the name must point at this server, ports 80 and 443 open)
  --port <number>   local port ClawRouter listens on (default 8080, on 127.0.0.1)
  --ref <git ref>   branch or tag to install (default: main)
  --yes, -y         do not ask for confirmation
  --force           continue on another Ubuntu version than 24.04
  --ascii           plain ASCII symbols only (chosen by itself on consoles without UTF-8)
  --skip-packages   never run apt (no package list update, no installs): the packages must
                    already be there, or the installer stops and prints the apt command
  --help, -h        this text

Running it again upgrades ClawRouter and keeps the secret key, settings and data.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --lan) LAN=1; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --skip-packages) SKIP_PACKAGES=1; shift ;;
    --ascii) ASCII=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf '\nUnknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

# Values that end up in files and commands are checked before anything else happens.
[[ "$PORT" =~ ^[0-9]{2,5}$ && "$PORT" -ge 1024 && "$PORT" -le 65535 ]] || { printf 'The port must be a number from 1024 to 65535.\n' >&2; exit 2; }
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || { printf 'Not a domain name: %s\n' "$DOMAIN" >&2; exit 2; }
[[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ && "$REF" != -* ]] || { printf 'Not a branch or tag name: %s\n' "$REF" >&2; exit 2; }
[[ $LAN -eq 1 && -n "$DOMAIN" ]] && { printf 'Use --lan or --domain, not both: with --domain, Caddy serves the network over HTTPS.\n' >&2; exit 2; }
[[ -n "$DOMAIN" ]] && TOTAL_STEPS=9
choose_symbols

# --- Steps ------------------------------------------------------------------------------
check_system() {
  [[ $EUID -eq 0 ]] || { printf 'Run the installer as root: curl -fsSL <url> | sudo bash\n' >&2; exit 1; }
  : >>"$LOG" && chmod 600 "$LOG"
  step "Checking the system"
  printf '\n==== ClawRouter installer, %s\n' "$(date -u +%FT%TZ)" >>"$LOG"

  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]]; then
    ok "Ubuntu $VERSION_ID ($(uname -m))"
  elif [[ $FORCE -eq 1 ]]; then
    warn "${PRETTY_NAME:-unknown system}: not Ubuntu 24.04, continuing because of --force"
  else
    fail "This installer is for Ubuntu 24.04; this is ${PRETTY_NAME:-an unknown system}." "Use --force to try anyway, or follow docs/deployment.md."
  fi

  case "$(uname -m)" in
    x86_64) if grep -qw avx2 /proc/cpuinfo; then BUN_BUILD="bun-linux-x64"; else BUN_BUILD="bun-linux-x64-baseline"; fi ;;
    aarch64|arm64) BUN_BUILD="bun-linux-aarch64" ;;
    *) fail "Unsupported processor: $(uname -m)." "Bun runs on x86_64 and arm64." ;;
  esac
  ok "Bun build: $BUN_BUILD"

  [[ -d /run/systemd/system ]] || fail "systemd is not running." "ClawRouter is installed as a systemd service; in a container, use the Docker image instead (docs/deployment.md#docker)."
  ok "systemd $(systemctl --version | awk 'NR==1 {print $2}')"

  local free_mb
  free_mb=$(df -Pm / | awk 'NR==2 {print $4}')
  [[ "$free_mb" -ge 1024 ]] || fail "Less than 1 GB free on / (${free_mb} MB)." "The build needs about 600 MB."
  ok "Disk space: ${free_mb} MB free"

  if [[ -d "$DIST_DIR" ]]; then
    MODE="upgrade"
    ok "Existing installation found: it will be upgraded (data, key and settings are kept)"
  else
    MODE="install"
    if ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; then
      fail "Port $PORT is already in use." "Choose another with --port."
    fi
    ok "Port $PORT is free"
  fi

  printf '\n'
  info "Source:  $REPO_URL ($REF)"
  info "Install: $PREFIX, data in $DATA_DIR, settings in $CONF_DIR"
  if [[ $LAN -eq 1 ]]; then
    info "Address: http://$(lan_address):$PORT (every network interface, plain HTTP)"
  else
    info "Address: ${DOMAIN:+https://$DOMAIN (through Caddy), }http://127.0.0.1:$PORT"
  fi
  printf '\n'
  confirm "$( [[ $MODE == upgrade ]] && echo "Upgrade ClawRouter now?" || echo "Install ClawRouter now?" )" || { info "Nothing was changed."; exit 0; }
}

install_packages() {
  step "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  local packages=(ca-certificates curl git unzip openssl) missing
  [[ -n "$DOMAIN" ]] && packages+=(caddy)
  mapfile -t missing < <(missing_packages "${packages[@]}")

  # Everything there already: apt is not touched at all (no package list update).
  if [[ ${#missing[@]} -eq 0 ]]; then
    ok "Already installed: ${packages[*]}"
    return
  fi
  if [[ $SKIP_PACKAGES -eq 1 ]]; then
    fail "Missing packages: ${missing[*]} (--skip-packages was given, so apt is not run)." "Install them first: sudo apt-get install -y ${missing[*]}"
  fi
  info "To install: ${missing[*]}"

  # A freshly booted server installs its security updates first and holds the package lock
  # meanwhile: wait for that openly instead of failing or spinning under the wrong label.
  if package_manager_busy; then
    info "Ubuntu is installing its automatic updates; the installer waits until they finish"
    run "Waiting for the automatic updates (up to 20 minutes)" wait_for_package_manager
  fi
  if package_lists_recent; then
    # Lists refreshed in the last day: install from them; only if that fails, update and retry.
    run "Installing ${missing[*]} (package lists are recent, not updated)" install_or_update_and_retry "${missing[@]}"
  else
    # Lock::Timeout covers an update that starts between the check and apt-get.
    run "Updating the package lists" apt-get -o DPkg::Lock::Timeout=600 update -q
    run "Installing ${missing[*]}" apt_install "${missing[@]}"
  fi
}

# The packages of "$@" that are not installed, one per line.
missing_packages() {
  local p
  for p in "$@"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || printf '%s\n' "$p"
  done
}

# The package lists were updated in the last 24 hours. The list files keep the mirror's dates,
# so this looks at when apt last wrote them: Ubuntu's stamp of the last successful update
# (update-notifier-common), or else the lists directory itself. Without lists, never recent.
package_lists_recent() {
  compgen -G '/var/lib/apt/lists/*_Packages*' >/dev/null || return 1
  [[ -n "$(find /var/lib/apt/periodic/update-success-stamp /var/lib/apt/lists -maxdepth 0 -mmin -1440 -print -quit 2>/dev/null)" ]]
}

apt_install() {
  apt-get -o DPkg::Lock::Timeout=600 install -y -q --no-install-recommends "$@"
}

install_or_update_and_retry() {
  apt_install "$@" && return 0
  printf 'Installing from the current package lists failed; updating them and trying again.\n'
  apt-get -o DPkg::Lock::Timeout=600 update -q && apt_install "$@"
}

# apt, dpkg or unattended-upgrades running (process names are cut to 15 characters).
package_manager_busy() {
  pgrep -x 'apt|apt-get|aptitude|dpkg|unattended-upgr|unattended-upgrade' >/dev/null 2>&1
}

wait_for_package_manager() {
  local i
  for i in $(seq 1 600); do
    package_manager_busy || return 0
    sleep 2
  done
  printf 'The package manager was still busy after 20 minutes:\n'
  pgrep -a -x 'apt|apt-get|aptitude|dpkg|unattended-upgr|unattended-upgrade' || true
  return 1
}

install_bun() {
  step "Installing Bun $BUN_VERSION"
  if [[ -x "$BUN" ]] && [[ "$("$BUN" --version 2>/dev/null)" == "$BUN_VERSION" ]]; then
    ok "Bun $BUN_VERSION is already installed ($BUN)"
    return
  fi
  local tmp url expected actual
  tmp=$(mktemp -d)
  url="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$BUN_BUILD.zip"
  expected="${BUN_SHA256[$BUN_BUILD]}"
  run_progress "Downloading $BUN_BUILD.zip" curl -fSL --progress-bar --retry 3 -o "$tmp/bun.zip" "$url"
  actual=$(sha256sum "$tmp/bun.zip" | awk '{print $1}')
  printf 'sha256 %s, expected %s\n' "$actual" "$expected" >>"$LOG"
  [[ "$actual" == "$expected" ]] || { rm -rf "$tmp"; fail "The Bun download does not match its SHA-256." "Expected $expected, got $actual. Nothing was installed."; }
  ok "Checksum verified (SHA-256 ${expected:0:16}${SYM_MORE})"
  run "Unpacking" unzip -q -o "$tmp/bun.zip" -d "$tmp"
  install -m 755 "$tmp/$BUN_BUILD/bun" "$BUN"
  rm -rf "$tmp"
  ok "Installed $BUN ($("$BUN" --version))"
}

fetch_source() {
  step "Getting ClawRouter ($REF)"
  install -d -m 755 "$PREFIX"
  if [[ -d "$SRC_DIR/.git" ]]; then
    run_progress "Fetching $REF" git -C "$SRC_DIR" fetch --progress --depth 1 origin "$REF"
    run "Checking out $REF" git -C "$SRC_DIR" reset --hard FETCH_HEAD
  else
    run_progress "Cloning $REPO_URL" git clone --progress --depth 1 --branch "$REF" "$REPO_URL" "$SRC_DIR"
  fi
  COMMIT=$(git -C "$SRC_DIR" rev-parse --short HEAD)
  VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$SRC_DIR/package.json" | head -n 1)
  ok "ClawRouter ${VERSION:-?} at commit $COMMIT"
}

build() {
  step "Building ClawRouter"
  rm -rf "$SRC_DIR/dist"
  # The lockfile is checked: every package must match its recorded hash (SEC-018).
  run "Installing dependencies (frozen lockfile)" env -C "$SRC_DIR" HOME=/root "$BUN" install --frozen-lockfile
  run "Building the server, console and tools" env -C "$SRC_DIR" HOME=/root "$BUN" run build
  ok "Build ready ($(du -sh "$SRC_DIR/dist" | awk '{print $1}'))"
}

prepare_host() {
  step "Preparing the service account, settings and secret key"
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    ok "Service account '$SERVICE_USER' exists"
  else
    run "Creating the service account '$SERVICE_USER'" useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$DATA_DIR"
  install -d -m 755 "$CONF_DIR"
  ok "Data directory $DATA_DIR (0700)"

  if [[ -s "$KEY_FILE" ]]; then
    ok "Secret key kept ($KEY_FILE)"
    NEW_KEY=0
  else
    (umask 077 && openssl rand -base64 32 >"$KEY_FILE")
    NEW_KEY=1
    ok "Secret key generated ($KEY_FILE)"
  fi
  chown "$SERVICE_USER:$SERVICE_USER" "$KEY_FILE"
  chmod 600 "$KEY_FILE"

  if [[ -f "$ENV_FILE" ]]; then
    ok "Settings kept ($ENV_FILE)"
  else
    install -m 600 "$SRC_DIR/deploy/clawrouter.env.example" "$ENV_FILE"
    sed -i "s/^CLAWROUTER_PORT=.*/CLAWROUTER_PORT=$PORT/" "$ENV_FILE"
    ok "Settings written ($ENV_FILE)"
  fi
  if [[ $LAN -eq 1 ]]; then
    # Plain HTTP on the network: the session cookie cannot be HTTPS-only, or browsers drop it.
    set_setting CLAWROUTER_HOST 0.0.0.0
    set_setting CLAWROUTER_COOKIE_SECURE false
    ok "Listening on every network interface over plain HTTP (--lan)"
  fi
  PORT=$(sed -n 's/^CLAWROUTER_PORT=//p' "$ENV_FILE" | tail -n 1)
  PORT=${PORT:-8080}
  LISTEN=$(sed -n 's/^CLAWROUTER_HOST=//p' "$ENV_FILE" | tail -n 1)
}

# Sets NAME=value in the settings file: replaces the line (also a commented-out one), or adds it.
set_setting() {
  if grep -qE "^#? ?$1=" "$ENV_FILE"; then
    sed -i -E "s|^#? ?$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

# The server's first IPv4 address on the network (for the console address in --lan mode).
lan_address() {
  local a
  a=$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  [[ -n "$a" ]] || a=$(hostname -I 2>/dev/null | awk '{print $1}')
  printf '%s' "${a:-SERVER-ADDRESS}"
}

# Runs a ClawRouter maintenance command as the service account with the service's settings.
as_service() {
  local vars
  mapfile -t vars < <(grep -Ev '^[[:space:]]*(#|$)' "$ENV_FILE")
  (cd "$DIST_DIR" && runuser -u "$SERVICE_USER" -- env "${vars[@]}" "$BUN" "$@")
}

wait_ready() {
  local i
  for i in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health/ready" 2>/dev/null && return 0
    sleep 1
  done
  journalctl -u clawrouter -n 30 --no-pager
  return 1
}

install_service() {
  step "Installing and starting the service"
  if [[ "$MODE" == "upgrade" ]] && systemctl is-active --quiet clawrouter; then
    run "Backing up the database before the upgrade" as_service cli/backup.js
  fi
  # Copy first, then swap: the running server's files are replaced in one rename.
  rm -rf "$DIST_DIR.new"
  cp -a "$SRC_DIR/dist" "$DIST_DIR.new"
  chown -R root:root "$DIST_DIR.new"
  chmod -R go-w "$DIST_DIR.new"
  if [[ -d "$DIST_DIR" ]]; then rm -rf "$DIST_DIR.old" && mv "$DIST_DIR" "$DIST_DIR.old"; fi
  mv "$DIST_DIR.new" "$DIST_DIR"
  rm -rf "$DIST_DIR.old"
  ok "Installed the build in $DIST_DIR"

  install -m 644 "$SRC_DIR/deploy/clawrouter.service" "$UNIT_FILE"
  run "Registering the systemd service (sandboxed, SEC-024)" systemctl daemon-reload
  run "Enabling it at boot" systemctl enable --quiet clawrouter
  run "Starting ClawRouter" systemctl restart clawrouter
  run "Waiting until it is ready" wait_ready
  if [[ "$LISTEN" == "0.0.0.0" ]]; then
    if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
      run "Opening port $PORT in the firewall" ufw allow "$PORT/tcp"
    else
      info "No active ufw firewall: port $PORT is reachable from the network"
    fi
  fi
}

setup_https() {
  step "Setting up HTTPS for $DOMAIN"
  local caddyfile=/etc/caddy/Caddyfile
  if [[ -f "$caddyfile" ]] && ! grep -q 'ClawRouter' "$caddyfile"; then
    cp "$caddyfile" "$caddyfile.before-clawrouter"
    info "Saved the previous Caddyfile as $caddyfile.before-clawrouter"
  fi
  sed -e "s/^clawrouter\.example\.com {/$DOMAIN {/" -e "s/127\.0\.0\.1:8080/127.0.0.1:$PORT/" "$SRC_DIR/deploy/Caddyfile" >"$caddyfile"
  run "Checking the Caddy configuration" caddy validate --config "$caddyfile" --adapter caddyfile
  run "Reloading Caddy" systemctl reload-or-restart caddy
  ok "Caddy proxies https://$DOMAIN to 127.0.0.1:$PORT"
  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
    run "Opening ports 80 and 443 in the firewall" ufw allow 80,443/tcp
  else
    info "No active ufw firewall: make sure ports 80 and 443 reach this server"
  fi
  info "Caddy asks Let's Encrypt for the certificate on the first visit; $DOMAIN must point here"
}

check_deployment() {
  step "Checking the deployment"
  local out code=0
  out=$(as_service cli/doctor.js 2>&1) || code=$?
  printf '%s\n' "$out" >>"$LOG"
  if [[ $code -eq 0 ]]; then ok "Deployment check: no problems found"; else warn "Deployment check reported problems:"; fi
  printf '%s\n' "$out" | grep -E '^\s*\[(WARN|FAIL)\]' | sed 's/^\s*/      /' | head -n 10 || true

  # The security check (SEC-025) also asks the running server: CSRF, CORS, its privileges.
  code=0
  out=$(as_service cli/doctor.js --security 2>&1) || code=$?
  printf '%s\n' "$out" >>"$LOG"
  local result
  result=$(printf '%s\n' "$out" | grep -E '^[0-9]+ passed' | tail -n 1)
  if [[ $code -eq 0 ]]; then ok "Security check: ${result:-passed}"; else warn "Security check: ${result:-failed}"; fi
  printf '%s\n' "$out" | grep -E '^\s*\[(WARN|FAIL)\]' | sed 's/^\s*/      /' | head -n 10 || true
}

summary() {
  local url token line
  url=${DOMAIN:+https://$DOMAIN}
  [[ -z "$url" && "$LISTEN" == "0.0.0.0" ]] && url="http://$(lan_address):$PORT"
  url=${url:-http://127.0.0.1:$PORT}
  token=""
  [[ -f "$DATA_DIR/setup-token" ]] && token=$(<"$DATA_DIR/setup-token")
  line=$(printf "%.0s$BOX_H" $(seq 1 66))
  printf '\n%s%s%s%s%s\n' "$GREEN" "$BOX_TL" "$line" "$BOX_TR" "$RESET"
  printf '%s%s%s  %-64s%s%s%s\n' "$GREEN" "$BOX_V" "$RESET$BOLD" "ClawRouter ${VERSION:-} is $( [[ $MODE == upgrade ]] && echo upgraded || echo installed ) (commit $COMMIT)" "$GREEN" "$BOX_V" "$RESET"
  printf '%s%s%s%s%s\n\n' "$GREEN" "$BOX_BL" "$line" "$BOX_BR" "$RESET"
  printf '  %sConsole%s     %s\n' "$BOLD" "$RESET" "$url"
  if [[ -n "$token" ]]; then
    printf '  %sSetup%s       open %s/setup and enter this one-time token:\n' "$BOLD" "$RESET" "$url"
    printf '              %s%s%s\n' "$CYAN$BOLD" "$token" "$RESET"
  fi
  [[ -z "$DOMAIN" && "$LISTEN" != "0.0.0.0" ]] && printf '  %sRemote use%s  ssh -L %s:127.0.0.1:%s you@this-server, then open http://localhost:%s\n' "$BOLD" "$RESET" "$PORT" "$PORT" "$PORT"
  printf '  %sService%s     systemctl status clawrouter %s journalctl -u clawrouter -f\n' "$BOLD" "$RESET" "$SYM_SEP"
  printf '  %sSettings%s    %s (then: systemctl restart clawrouter)\n' "$BOLD" "$RESET" "$ENV_FILE"
  printf '  %sUpgrade%s     run this installer again\n' "$BOLD" "$RESET"
  printf '  %sLog%s         %s\n' "$BOLD" "$RESET" "$LOG"
  if [[ "${NEW_KEY:-0}" -eq 1 ]]; then
    printf '\n  %s!  Back up the secret key now%s, somewhere other than this server:\n' "$YELLOW$BOLD" "$RESET"
    printf '       %ssudo cat %s%s\n' "$BOLD" "$KEY_FILE" "$RESET"
    printf '     Keep it in a password manager. Without it, stored provider keys cannot be\n'
    printf '     read again, and database backups cannot be restored with them.\n'
  fi
  if [[ "$LISTEN" == "0.0.0.0" && -z "$DOMAIN" ]]; then
    printf '\n  %s%s  Plain HTTP on the network%s: passwords and API keys cross it unencrypted, and\n' "$YELLOW$BOLD" "$SYM_WARN" "$RESET"
    printf '     the security check reports that as a failure. Fine on a trusted home or office\n'
    printf '     network; for anything reachable from the internet, use --domain (HTTPS).\n'
  fi
  printf '\n'
}

banner
check_system
install_packages
install_bun
fetch_source
build
prepare_host
install_service
[[ -n "$DOMAIN" ]] && setup_https
check_deployment
summary
