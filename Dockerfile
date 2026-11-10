# syntax=docker/dockerfile:1
#
# unifi-local-mcp service image (spec §14; ADR 0017).
#
# - Node.js runs the TypeScript sources directly (type stripping, ADR 0002): no compile
#   step, and node:sqlite is built in, so there are no native modules (ADR 0004).
# - Two stages: production dependencies are installed without lifecycle scripts; the final
#   image has no npm, npx or corepack.
# - Runs as an unprivileged user and works with a read-only root filesystem; the only
#   writable path it needs is the /data volume (and /tmp, if mounted).
# - The base image is pinned by digest. Update both the tag and the digest together.
ARG NODE_IMAGE=node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf /root/.npm

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="unifi-local-mcp" \
      org.opencontainers.image.description="Self-hosted MCP server for the official local UniFi APIs" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"

# Package managers are not needed at run time.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && groupadd --system --gid 10001 unifimcp \
 && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin unifimcp \
 && mkdir -p /data \
 && chown 10001:10001 /data \
 && chmod 0700 /data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE NOTICE ./
COPY packages ./packages
COPY api-specs ./api-specs
COPY deploy/bin/unifi-mcp deploy/bin/unifi-mcp-bridge /usr/local/bin/

ENV NODE_ENV=production \
    UNIFI_MCP_DATA_DIR=/data \
    UNIFI_MCP_API_SPECS_DIR=/app/api-specs

USER 10001:10001
VOLUME ["/data"]
EXPOSE 3000 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["node", "/app/packages/mcp-server/src/healthcheck.ts"]
ENTRYPOINT ["node", "/app/packages/mcp-server/src/main.ts"]
