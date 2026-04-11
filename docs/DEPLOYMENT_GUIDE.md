# Deployment Guide

This guide covers the deployment path for a release candidate that is intended to be published externally.

## 1. Deployment Model

Recommended runtime model:

- Node.js 20.x
- npm 10.x
- PostgreSQL
- deployment platform secrets instead of a workspace `.env`
- runtime data outside the repository workspace

Supported targets:

- Zeabur
- Docker-based platforms
- any managed Node runtime with persistent PostgreSQL access

## 2. Preconditions

Before deploying, confirm all of the following:

- `npm run verify:release` is green
- `npm run test:real-db` is green
- production secrets are stored in the deployment platform
- `APP_RUNTIME_DIR`, `APP_BACKUP_DIR`, and `APP_LOG_DIR` resolve outside the repository workspace
- the latest backup passes `npm run restore:check`
- GitHub Actions `required-checks` and `docker-smoke` are green

Operator sign-off lives in [OPERATOR_RELEASE_READINESS.md](OPERATOR_RELEASE_READINESS.md).

## 3. Required Platform Variables

Required for most production deployments:

- `NODE_ENV=production`
- `DATABASE_URL`
- `SESSION_SECRET`
- `SESSION_SECURE=true`
- `TRUST_PROXY=true`
- `APP_RUNTIME_DIR`
- `APP_BACKUP_DIR`
- `APP_LOG_DIR`

Required when backup encryption is enabled:

- `BACKUP_ENCRYPTION_KEY`

Required when AES mode is enabled:

- `USE_AES_ENCRYPTION=true`
- `ENCRYPTION_KEY`
- `ENCRYPTION_SALT`

Required when LINE integration is enabled:

- `LINE_LOGIN_CHANNEL_ID`
- `LINE_LOGIN_CHANNEL_SECRET`
- `LINE_LOGIN_CALLBACK_URL`
- `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`
- `LINE_MESSAGING_CHANNEL_SECRET`

Reference: [CONFIGURATION.md](CONFIGURATION.md)

## 4. Build And Database Preparation

Install and verify locally:

```bash
npm install
npm run check
npm test
npm run build
```

Apply schema updates:

```bash
npm run db:push
```

Run the release gate:

```bash
npm run verify:release
npm run test:real-db
```

## 5. Platform Deployment

### Zeabur

- connect the repository
- use the repository `Dockerfile` if the platform detects it
- configure all secrets in the service variables screen
- do not set `PORT` manually unless the platform requires it
- do not upload a workspace `.env`
- do not keep `NPM_CONFIG_PRODUCTION`, `npm_config_production`, `NPM_CONFIG_OMIT`, or `npm_config_omit` in service variables, because they can strip build-time dependencies during Docker builds
- when cloning variables from an older service, remove `APP_RUNTIME_DIR`, `APP_BACKUP_DIR`, and `APP_LOG_DIR` if they point inside `/app` or the repository workspace; letting the app fall back to its safe default runtime root is usually the easiest migration path
- if a Supabase pooler URL fails with `self-signed certificate in certificate chain`, set `PGSSLREJECT_UNAUTHORIZED=false`; this exception is intentionally limited to known Supabase pooler hosts

### Docker-based platforms

- build from the repository root
- inject all runtime secrets at deploy time
- mount or provision a runtime directory outside the app workspace for backups and logs

## 6. Post-Deploy Smoke Checks

Set the deployed base URL and run:

```bash
BASE_URL="https://your-app.example.com"

curl "$BASE_URL/api/health"
curl "$BASE_URL/ready"
curl "$BASE_URL/live"
```

Expected outcomes:

- `/api/health` returns `200` with `status: "healthy"`
- `/ready` returns `200` with `ready: true`
- `/live` returns `200` with `alive: true`

Then verify these operator paths manually:

- admin login and logout
- employee list page
- attendance list page
- salary record list page
- dashboard backup list
- dashboard operational metrics

If LINE is enabled, also verify:

- `/api/line/login`
- `/api/line/callback`
- `/api/line/webhook`
- LINE clock-in flow

## 7. Canary Rollout

Recommended rollout pattern:

1. deploy to production infrastructure
2. allow only a small beta or allowlist cohort
3. monitor `/api/dashboard/operational-metrics`
4. create a fresh manual backup before widening traffic
5. expand traffic only after the canary window remains stable

Monitor closely during the canary:

- admin login failures
- invalid LINE webhook signatures
- stale LINE webhook events
- attendance list latency
- salary record list latency
- backup create, restore, and delete failures

## 8. Rollback Rules

Rollback immediately if any of the following occur:

- `/api/health` degrades and does not recover quickly
- login failures spike unexpectedly after deploy
- LINE webhook signatures begin failing after a configuration change
- attendance or salary list latency regresses sharply under real traffic
- backup or restore workflows fail during the release window

Rollback procedure:

1. stop widening traffic
2. preserve logs and operational metrics evidence
3. create a fresh manual backup if the system is still stable enough
4. revert to the previous application version
5. rerun health probes and smoke checks
6. document the incident in the operator log

## 9. External Platform Steps

These items are not fully enforceable from repository code alone and must be completed by the operator:

- rotate production secrets in the deployment platform
- require `required-checks` and `docker-smoke` on `main`
- restrict direct pushes to `main` except for a documented incident procedure
