# Maintenance Guide

This document defines the recurring maintenance work needed to keep the project safe, lean, and publishable.

## Weekly Tasks

- review `/api/dashboard/operational-metrics` for repeated failures or latency drift
- confirm the latest backup still passes `npm run restore:check`
- review audit logs for suspicious admin access patterns
- confirm runtime backups and logs are being written outside the repository workspace

## Monthly Tasks

- run `npm run verify:release`
- run `npm run test:real-db`
- review production secrets ownership and confirm no workspace `.env` is being used
- review branch protection settings on `main`
- confirm the public API documentation still matches live routes

## Quarterly Tasks

- rotate production secrets according to the team policy
- review backup retention and cleanup policy
- review operator access and SUPER admin access
- review LINE credentials, callback URLs, and webhook behavior
- re-audit release docs for drift or obsolete instructions

## Data Hygiene

Areas that still deserve periodic cleanup:

- orphaned assets such as `attached_assets/`
- stale release notes or superseded docs in the repository root
- disconnected UI components that are no longer reachable from live routes
- runtime artifacts that should not remain in source-controlled paths

## Structural Debt To Track

The project is releaseable, but these structural items should stay on the maintenance backlog:

- split `server/storage.ts` into narrower domain modules
- split `server/db-monitoring.ts` into focused operational modules
- continue removing residual mojibake in non-primary paths
- consolidate overlapping historical documentation into a smaller active set

## When To Open A Maintenance Track

Open a dedicated maintenance or refactor cycle when any of the following is true:

- the operator docs drift from actual runtime behavior
- API latency trends upward for multiple release windows
- backup and restore ownership becomes difficult to reason about
- new features start touching unrelated parts of `server/storage.ts`
- public documentation begins to accumulate conflicting instructions

## Suggested Maintenance Gate

Use this baseline before merging a maintenance batch:

```bash
npm run verify:release
npm run test:real-db
git diff --check
```
