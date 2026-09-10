# syntax=docker/dockerfile:1
# [breadcrumb] @COUPLED compose.yaml, .dockerignore, scripts/lifecycle/container.mjs
# @CONTRACT Use the same locked setup and root build as a host checkout.
FROM node:22.19.0-bookworm-slim AS base
WORKDIR /app
# Keep the upstream native-addon toolchain and optional DSH runtime conventions.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@10.9.3 @deepseek-ai/dsh@0.1.1-rc.2

FROM base AS build
RUN chown node:node /app
USER node
COPY --chown=node:node . .
RUN npm run setup:dependencies
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts --offline \
    && npm --prefix vendor/pi-web-ui prune --omit=dev --ignore-scripts --offline

FROM base AS runtime
ENV NODE_ENV=production \
    PI_DEV_CONFIG_DIR=/config \
    PI_DEV_STATE_DIR=/data \
    PI_WEB_DATA_DIR=/data/web \
    PI_CODING_AGENT_DIR=/data/agent \
    PI_WEB_CWD=/workspace \
    PI_WEB_PORT=8788 \
    PI_DEV_PROFILE=lean
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/scripts/lib.mjs /app/scripts/configure.mjs /app/scripts/start.mjs ./scripts/
COPY --from=build /app/scripts/lifecycle/files.mjs /app/scripts/lifecycle/container.mjs ./scripts/lifecycle/
COPY --from=build /app/vendor/pi-web-ui/package.json ./vendor/pi-web-ui/
COPY --from=build /app/vendor/pi-web-ui/node_modules ./vendor/pi-web-ui/node_modules
COPY --from=build /app/vendor/pi-web-ui/dist ./vendor/pi-web-ui/dist
COPY --from=build /app/vendor/pi-web-ui/web/dist ./vendor/pi-web-ui/web/dist
COPY --from=build /app/vendor/pi-web-ui/lib ./vendor/pi-web-ui/lib
COPY --from=build /app/vendor/pi-web-ui/themes ./vendor/pi-web-ui/themes
COPY --from=build /app/vendor/pi-web-ui/extensions ./vendor/pi-web-ui/extensions
COPY --from=build /app/vendor/pi-web-ui/plugins ./vendor/pi-web-ui/plugins
COPY --from=build /app/vendor/pi-web-ui/bin ./vendor/pi-web-ui/bin
RUN mkdir -p /config /data/web /data/agent /workspace \
    && chown node:node /config /data /data/web /data/agent /workspace \
    && chmod 700 /config /data/web /data/agent
VOLUME ["/config", "/data/web", "/data/agent", "/workspace"]
EXPOSE 8788
USER node
WORKDIR /workspace
CMD ["node", "/app/scripts/lifecycle/container.mjs"]
