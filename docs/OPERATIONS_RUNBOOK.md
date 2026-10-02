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

## 3. Dependency And Runtime Monitoring

Review update signals weekly:

```bash
npm run runtime:update:audit
npm outdated
npm audit --omit=dev
```

Then check:

- open Dependabot PRs for npm, Docker, and GitHub Actions
- GitHub security alerts
- GitHub Actions deprecation notices
- Zeabur build or runtime deprecation notices
- Node.js LTS and EOL status

Runtime updates must be tested locally before GitHub or Zeabur is changed. Follow
[DEPENDENCY_UPDATE_POLICY.md](DEPENDENCY_UPDATE_POLICY.md) for the required order.
The current deployment contract is Node.js 24.x and npm 11.x.

## 4. Verification Commands

Core release verification:

```bash
npm run verify:release
```

Extended real-database verification (isolated synthetic data only):

`test:real-db` 會新增／清理資料，且可能讀取 `.env`。先核對 `.env`、`DATABASE_URL`
及 `REAL_DB_TEST_DATABASE_URL`，只允許可丟棄、僅 loopback 連線的合成測試庫；
不得對正式或共用資料庫執行。

```bash
npm run test:real-db
```

Backup readiness:

```bash
npm run restore:check:required
```

這項檢查只檢視備份並讀取目前筆數，不是實際還原演練；一般 `restore:check` 的
skip 不算通過。以下演練會取得資料表鎖並在交易內替換後回復資料，只能在隔離的
合成測試庫執行，不能當成正式唯讀檢查：

```bash
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

## 5. Backup Operations

Preferred workflow:

1. create a manual backup from the dashboard
2. record the backup ID in the operator log
3. run `npm run restore:check:required`
4. keep the backup ID available before any risky change or rollout

Backup handling rules:

- do not store runtime backups inside the repository workspace
- do not delete the most recent known-good backup during an active incident
- treat backup encryption keys as production secrets

## 6. Restore Procedure

Before restoring:

1. identify the source backup ID
2. confirm who approved the restore
3. confirm a fresh pre-restore backup exists
4. record the incident reason and target window

Restore steps:

薪資更正後的還原必須遵循
[薪資更正上線與復原規則](PAYROLL_CORRECTION_RELEASE_RUNBOOK.md#備份還原)，
不能只還原薪資列或只憑 backup ID 執行。

1. 先用 SUPER 權限取得所選備份的還原預覽，核對每筆 `changedSalaryRecords`、
   journal replacement、修訂與總薪資／扣款／實領差額；總差額為零不能取代逐筆核對。
2. 提出確切影響並取得同意，保留還原前保護備份，再確認同一份有效預覽；
   若資料或備份已改變，重新預覽，不沿用舊確認權杖。
3. 按專用流程完成原子還原、管理員工作階段失效及重新登入。完整 PostgreSQL 外部還原
   另須停止並排空全部 writer、處理 epoch 與既有列印權杖；應用程式 JSON 還原測試不涵蓋此步驟。

4. validate:

- `/api/health`
- `/ready`
- admin login
- employee list
- attendance list
- salary record list

另核對薪資、journal、修訂與序列一致性，以及未納入 JSON 還原的
`monthly_salary_runs`、PDF 和已寄送紀錄。不得用自動重算或重寄補救。

5. document:

- operator
- restore source backup ID
- pre-restore backup ID
- timestamp
- post-restore validation result

若只需回退應用程式，依[相容維護回退規則](PAYROLL_MAINTENANCE_ROLLBACK.md)
核對確切 artifact／SHA 與資料相容性；保留目前 schema 和 journal，不等同執行資料還原。

## 7. Incident Response

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

## 8. LINE-Specific Checks

If LINE integration is enabled, verify after any secret or callback change:

- login redirect works
- callback establishes a session
- webhook accepts valid signatures
- invalid signatures are counted but do not crash the route
- stale events are ignored as expected

## 9. Access And Change Control

- SUPER admin access should be limited to trusted operators
- production secret changes should be traceable to a named operator
- release windows should always have a rollback owner
- direct `main` pushes should stay disabled unless an incident procedure explicitly allows them

## 10. Source Documents

- [OPERATOR_RELEASE_READINESS.md](OPERATOR_RELEASE_READINESS.md)
- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)
- [CONFIGURATION.md](CONFIGURATION.md)
- [DEPENDENCY_UPDATE_POLICY.md](DEPENDENCY_UPDATE_POLICY.md)
- [PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md)
