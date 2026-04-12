# Zeabur Build Contract

## Why Earlier Deployments Failed

Earlier Zeabur failures were caused by the build phase not receiving `devDependencies`.
This project keeps `vite`, `esbuild`, Tailwind tooling, and related build-time packages in `devDependencies`.
When a platform performs a production-style install during the build phase, the result is:

- `vite not found`
- `sh: vite: not found`
- `Cannot find package 'vite' imported from /app/node_modules/.vite-temp/vite.config.ts`

The root issue is not that `vite` is missing from `package.json`.
The root issue is that the build environment can accidentally skip build-time dependencies.

## Current Deployment Contract

The repository now uses the following contract:

1. Preferred production path: repo-root `Dockerfile`
2. Builder install: `npm ci --include=dev`
3. Builder environment neutralizes production-style npm omission flags
4. Root `.npmrc` fallback: `include=dev`
5. Runtime install: `npm ci --omit=dev`
6. Rollup native fallback: `node scripts/ensure-rollup-native.mjs`
7. Production runtime bundle guard: `node scripts/verify-runtime-bundle.mjs`

This means:

- Docker builds install Vite explicitly during the build stage.
- Docker builds copy `.npmrc` before dependency installation so the `include=dev` fallback is available inside the image build.
- Docker builds ignore `NPM_CONFIG_PRODUCTION` / `NPM_CONFIG_OMIT` style flags during the builder phase.
- Runtime images still exclude unnecessary build tooling.
- The server production bundle is verified to exclude `vite`, `@vitejs/plugin-react`, and `vite.config.ts`.
- If a platform falls back to a plain Node builder instead of the Dockerfile, the repo still has a safety net.

## Why The Dockerfile Stays On Debian Slim

The current image uses `node:20-bookworm-slim` instead of Alpine on purpose.

Reasons:

- native dependencies such as Rollup and esbuild are typically more predictable on glibc-based images
- it reduces surprise around Linux binary selection
- it matches the pinned runtime contract in `package.json`

Alpine can work, but it is a higher-variance choice for this project because of native build tooling.

## Local Verification Standard

Use this command before shipping deployment-related changes:

```bash
npm run verify:ci
```

That command runs:

- `npm run check`
- `npm test`
- `npm run build`

## CI Gate

GitHub Actions now enforces two checks:

1. clean Linux install and full verify run
2. Docker smoke build

This is meant to catch Zeabur-style build regressions before they reach production.

## Zeabur Checklist

When redeploying on Zeabur:

1. Build the latest `main` commit from the repo root
2. Prefer the repo `Dockerfile`
3. Do not override install/build commands unless necessary
4. Remove `NPM_CONFIG_PRODUCTION`, `npm_config_production`, `NPM_CONFIG_OMIT`, and `npm_config_omit` from Zeabur Variables
5. Clear the Zeabur build cache if the logs still reflect an older install strategy
6. Replace any plaintext `SUPER_ADMIN_PIN` with a hashed value generated via `npm run super-pin:hash -- --raw <your-pin>`

## Zeabur Runtime Guardrails

Zeabur startup can still fail even when the image build succeeds if production variables do not satisfy runtime validation.

The most common example is:

- `SUPER_ADMIN_PIN` left as plaintext from an older deployment

In production, the app rejects plaintext values and exits with:

```text
Error: SUPER_ADMIN_PIN must be hashed in production
```

To fix this, generate a hash locally and paste the resulting value into the Zeabur variable:

```bash
npm run super-pin:hash -- --raw <your-pin>
```

## When A Build Fails Again

Collect these four facts before changing code:

1. commit SHA that Zeabur is building
2. whether Zeabur is using Docker or a Node builder
3. the exact install command shown in the build log
4. the last 60 to 100 lines of the failed build log

That is enough to distinguish:

- stale cache
- wrong root directory
- Node builder fallback
- missing build dependency install
- a real application build break
