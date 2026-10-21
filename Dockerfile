FROM node:24.16.0-bookworm-slim AS builder

WORKDIR /app
ENV NODE_ENV=development \
    NPM_CONFIG_PRODUCTION=false \
    npm_config_production=false \
    NPM_CONFIG_INCLUDE=dev \
    npm_config_include=dev \
    NPM_CONFIG_OMIT= \
    npm_config_omit= \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=120000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev --include=optional \
    && test -x node_modules/.bin/vite \
    && test -x node_modules/.bin/esbuild \
    && node -e "require.resolve('@rollup/rollup-linux-x64-gnu/package.json')"

COPY . .
RUN npm run build

FROM node:24.16.0-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=120000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY --from=builder /app/dist ./dist
COPY scripts/container-entrypoint.sh /usr/local/bin/app-entrypoint

RUN mkdir -p backups logs \
    && chown -R node:node /app \
    && chmod 0755 /usr/local/bin/app-entrypoint \
    && command -v setpriv >/dev/null

USER node

EXPOSE 8080

# 以 node 啟動時直接執行；以 root 啟動（Railway volume）時先整理 volume 權限再降權成 node。
ENTRYPOINT ["/usr/local/bin/app-entrypoint"]
CMD ["node", "dist/index.js"]
