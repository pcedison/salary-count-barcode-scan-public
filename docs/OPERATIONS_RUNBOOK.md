# Operations Runbook

This runbook is for operators responsible for production health, release monitoring, backup safety, and incident response.

## 1. Daily Checks

Verify service health:

```bash
curl https://your-app.example.com/api/health
curl https://your-app.example.com/ready
curl https://your-app.example.com/live
npm run smoke:live -- --base-url https://your-app.example.com
```

Expected outcomes:

- `/api/health` returns `200` and `status: "healthy"`
- `/ready` returns `200` and `ready: true`
- `/live` returns `200` and `alive: true`

Then review the SUPER-admin dashboard:

- backup list loads successfully
- operational metrics load successfully
- no unexplained spike appears in failure counters

The live smoke command writes a JSON report to `tmp/` by default and classifies each check as `pass`, `fail`, or `blocked`.

## 2. Release Monitoring

Primary operator telemetry is exposed at:

- `GET /api/dashboard/operational-metrics`

Review these fields during release windows:

- `auth.adminLoginFailures`
- `line.invalidWebhookSignatures`
- `line.staleWebhookEvents`
- `backup.createFailures`
- `backup.restoreFailures`
- `backup.deleteFailures`
- `api.attendanceListLatency`
- `api.salaryRecordListLatency`

Interpretation guidance:

- rising login failures may indicate operator confusion, brute force attempts, or a changed PIN flow
- invalid webhook signatures usually mean a mismatched LINE secret or proxy/body handling issue
- stale webhook events may indicate replay-window or system-clock problems
- list latency regressions usually point to database stress, query regressions, or infrastructure contention

## 3. Verification Commands

Core release verification:

```bash
npm run verify:release
```

Extended real-database verification:

```bash
npm run test:real-db
```

Backup readiness:

```bash
npm run restore:check
npm run restore:rehearse
```

AES readiness, when AES mode is used:

```bash
npm run aes:inspect
npm run aes:report
npm run aes:snapshot
npm run aes:rehearse
npm run aes:ready
```

## 4. Backup Operations

Preferred workflow:

1. create a manual backup from the dashboard
2. record the backup ID in the operator log
3. run `npm run restore:check`
4. keep the backup ID available before any risky change or rollout

Backup handling rules:

- do not store runtime backups inside the repository workspace
- do not delete the most recent known-good backup during an active incident
- treat backup encryption keys as production secrets

## 5. Restore Procedure

Before restoring:

1. identify the source backup ID
2. confirm who approved the restore
3. confirm a fresh pre-restore backup exists
4. record the incident reason and target window

Restore steps:

1. trigger restore from the dashboard with a validated backup ID
2. wait for completion
3. rerun:

```bash
npm run restore:check
```

4. validate:

- `/api/health`
- `/ready`
- admin login
- employee list
- attendance list
- salary record list

5. document:

- operator
- restore source backup ID
- pre-restore backup ID
- timestamp
- post-restore validation result

## 6. Incident Response

Use this escalation order:

1. stabilize user impact
2. preserve evidence
3. stop rollout expansion
4. confirm database and session health
5. decide rollback versus hotfix

Evidence to capture:

- failing endpoint and timestamp
- `/api/health`, `/ready`, and `/live` output
- dashboard operational metrics snapshot
- recent audit logs
- relevant deployment identifiers

## 7. LINE-Specific Checks

If LINE integration is enabled, verify after any secret or callback change:

- login redirect works
- callback establishes a session
- webhook accepts valid signatures
- invalid signatures are counted but do not crash the route
- stale events are ignored as expected

## 8. Access And Change Control

- SUPER admin access should be limited to trusted operators
- production secret changes should be traceable to a named operator
- release windows should always have a rollback owner
- direct `main` pushes should stay disabled unless an incident procedure explicitly allows them

## 9. Source Documents

- [OPERATOR_RELEASE_READINESS.md](OPERATOR_RELEASE_READINESS.md)
- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)
- [CONFIGURATION.md](CONFIGURATION.md)
- [PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md)
