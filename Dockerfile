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
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV CLAWROUTER_ENV=production \
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
