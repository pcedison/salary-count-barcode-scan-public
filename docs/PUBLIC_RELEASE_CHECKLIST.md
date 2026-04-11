# Public Release Checklist

Use this checklist before expanding from internal or limited rollout to broader public access.

## Secrets

- Rotate all live production secrets if a workstation copy of `.env` was ever shared, synced, or archived.
- Store production values only in the deployment platform or secret manager.
- Confirm production hosts do not keep a workspace `.env`.
- Do not use `ALLOW_DOTENV_IN_PRODUCTION=true` except for a documented emergency.
- Confirm `SUPER_ADMIN_PIN` is hashed, not plaintext.

## Runtime paths

- Set `APP_RUNTIME_DIR`, `APP_BACKUP_DIR`, and `APP_LOG_DIR` to paths outside the repository workspace.
- Confirm backups and audit logs no longer write into synced folders such as OneDrive-backed project roots.
- Run `npm run restore:check` after the runtime path move.

## CI and merge gates

- Confirm GitHub Actions `required-checks` is green.
- Confirm GitHub Actions `docker-smoke` is green.
- Enable branch protection on `main` and require:
  - `required-checks`
  - `docker-smoke`
- Disallow direct pushes to `main` unless there is an explicit incident procedure.

## Monitoring and rollback

- Confirm `/api/dashboard/operational-metrics` is reachable for SUPER admins.
- Review:
  - admin login failures
  - LINE invalid webhook signatures
  - LINE stale webhook events
  - attendance list latency
  - salary record list latency
  - backup create/restore/delete failures
- Create a fresh manual backup before widening traffic.
- Confirm the latest backup passes `npm run restore:check`.

## Canary release

- Start with a small allowlist, beta cohort, or internal/public canary.
- Watch operational metrics and audit logs during the first live traffic window.
- Only expand traffic after the canary window stays stable.
