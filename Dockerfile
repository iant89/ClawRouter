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

# ClawRouter container image (phase 17). See docs/deployment.md.
#
#   docker build -t clawrouter .
#   docker run -d --name clawrouter -p 8080:8080 -v clawrouter-data:/data \
#     -e CLAWROUTER_SECRET_KEY_FILE=/run/secrets/clawrouter_key ... clawrouter
#
# Build: install (including the vendored ENTERPRISE-UI), then bundle server,
# console and maintenance commands into dist/. The image keeps only dist/.
FROM oven/bun:1.4.4-slim AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY vendor ./vendor
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
# Behind a TLS-inspecting proxy, pass its certificate authority: docker build --secret id=ca,src=/path/to/ca.pem .
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; bun install --frozen-lockfile
RUN bun run build

FROM oven/bun:1.4.4-slim
WORKDIR /app/dist
COPY --from=build /src/dist ./
# Data (database, backups, the setup token) lives on a volume, owned by the unprivileged bun user.
RUN mkdir -p /data && chown bun:bun /data && chmod 700 /data
USER bun
ENV CLAWROUTER_ENV=production \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    CLAWROUTER_HOST=0.0.0.0 \
    CLAWROUTER_PORT=8080 \
    CLAWROUTER_DATABASE_PATH=/data/clawrouter.db
VOLUME /data
EXPOSE 8080
# Readiness: 503 while draining for a restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.CLAWROUTER_PORT || 8080) + '/api/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# SIGTERM drains in-flight requests (CLAWROUTER_SHUTDOWN_GRACE_SECONDS, 30): give `docker stop -t` more.
STOPSIGNAL SIGTERM
CMD ["bun", "main.js"]
