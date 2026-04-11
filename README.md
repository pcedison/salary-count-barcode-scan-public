# barcode_scan_V3

`barcode_scan_V3` is a PostgreSQL-first employee attendance and salary management system with barcode scan flows, session-based admin access, backup and restore tooling, and optional LINE integration.

This public repository was recreated as a clean-room snapshot on 2026-04-12 from a sanitized private codebase. Internal history, handoff notes, and archived operational materials were intentionally excluded.

## Release Status

The current codebase is ready for a controlled public release.

Before a broad public rollout, operators should still complete the external platform steps in [docs/OPERATOR_RELEASE_READINESS.md](docs/OPERATOR_RELEASE_READINESS.md):

- rotate production secrets in the deployment platform
- require GitHub checks on `main`
- run a short canary window with live monitoring

## Core Capabilities

- session-based admin authentication with SUPER escalation
- employee, attendance, salary, and holiday management
- barcode kiosk and device-token-protected scan flows
- LINE login, binding, clock-in, and webhook handling
- PostgreSQL backups, restore-readiness checks, and rehearsal scripts
- release monitoring through `/api/dashboard/operational-metrics`

## Stack

- React 18 + TypeScript + Vite
- Express + TypeScript
- Drizzle ORM + PostgreSQL
- Vitest for test, smoke, and real-database verification

## Local Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure local environment variables in `.env`.

Minimum local example:

```env
NODE_ENV=development
PORT=5000
DATABASE_URL=postgresql://<db-user>:<db-password>@db.example.test:5432/<db-name>
SESSION_SECRET=replace-with-at-least-32-characters
```

3. Apply the schema:

```bash
npm run db:push
```

4. Start the app:

```bash
npm run dev
```

## Release Verification

Primary release gate:

```bash
npm run verify:release
```

Extended database verification:

```bash
npm run test:real-db
```

## Documentation Map

- [API_DOCUMENTATION.md](API_DOCUMENTATION.md): live API contract
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): environment variables and runtime path policy
- [docs/OPERATOR_RELEASE_READINESS.md](docs/OPERATOR_RELEASE_READINESS.md): operator go/no-go checklist before publishing
- [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md): deployment and canary rollout procedure
- [docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md): day-2 operations and incident response
- [docs/MAINTENANCE.md](docs/MAINTENANCE.md): recurring maintenance tasks and cleanup cadence
- [docs/PUBLIC_RELEASE_CHECKLIST.md](docs/PUBLIC_RELEASE_CHECKLIST.md): short public-release checklist
- [docs/ZEABUR_BUILD_CONTRACT.md](docs/ZEABUR_BUILD_CONTRACT.md): deployment contract and build expectations for Zeabur

## Public Release Notes

- Production must not load a workspace `.env` by default.
- Production backups and audit logs must live outside the repository workspace.
- `GET /api/attendance` and `GET /api/salary-records` are paginated by default.
- `GET /api/dashboard/operational-metrics` is the primary release-monitoring endpoint for SUPER admins.
