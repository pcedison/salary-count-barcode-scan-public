# Operator Release Readiness

This is the operator-facing go or no-go document for publishing `barcode_scan_V3` as a public release.

## Historical Recommendation

以下是早期候選版本的歷史評估，未綁定本輪來源 SHA／執行日期，不構成目前版本通過、
正式部署已驗證或新的發布授權。每次發布須記錄當次版本、實際結果及略過／未驗證項目。

Historical state:

- code and test readiness: pass
- runtime path hardening: pass
- backup and restore readiness: pass
- operator observability: pass
- external platform follow-up: still required

Recommendation:

- controlled public release: approved
- broad public rollout: approved only after the operator closes the external platform items below

## Historical Validated Baseline

Previously recorded baseline on Node.js 24.16.0 / npm 11.13.0:

- `npm run verify:release`
- `npm run test:real-db`
- `git diff --check`

Historical results (not current test counts):

- `npm test`: `57` files and `273` tests passed
- `npm run test:smoke`: `17` files and `105` tests passed
- `npm run test:real-db`: `2` files and `7` tests passed

## Go Or No-Go Matrix

下表的 `Pass` 為上述歷史候選評估；平台設定、備份可用性與當次測試必須重新核對。

| Area | Status | Operator action |
| --- | --- | --- |
| Code verification | Pass | Keep `verify:release` green before publish. |
| Real database verification | Pass | Rerun `test:real-db` only in a disposable loopback database with synthetic data. |
| Runtime path policy | Pass | Confirm backups and logs stay outside the workspace. |
| Runtime/dependency freshness | Required | Review Dependabot PRs and run `npm run runtime:update:audit` before release. |
| Backup readiness | Pass | Create a fresh manual backup before widening traffic. |
| Operator observability | Pass | Monitor `/api/dashboard/operational-metrics` during canary. |
| Production secret rotation | Required | Rotate secrets in the deployment platform. |
| Branch protection on `main` | Pass | `required-checks`, `docker-smoke`, and `Mobile UI structural checks` are enforced on `main`, including admins. |
| Public documentation set | Pass | Publish using the updated operator and deployment docs. |
| Legacy doc cleanup | Follow-up | Archive or rewrite remaining historical docs over time. |

## Required Operator Closures

These items must be completed by an operator outside repository code:

1. Rotate live production secrets in the deployment platform.
2. Confirm production does not rely on a workspace `.env`.
3. Keep GitHub checks on `main` enforced:
   - `required-checks`
   - `docker-smoke`
   - `Mobile UI structural checks`
4. Keep direct pushes to `main` restricted except for a documented incident process.

## Pre-Publish Checklist

Before pushing a public release:

1. 在隔離測試環境執行。`test:real-db` 會新增／清理資料，且可能讀取 `.env`；
   先核對 `.env`、`DATABASE_URL` 與 `REAL_DB_TEST_DATABASE_URL`，只能指向可丟棄、
   僅 loopback 連線且全為合成資料的測試庫，不能使用正式或共用資料庫。

```bash
npm run verify:release
npm run test:real-db
npm run runtime:update:audit
git diff --check
```

   `verify:release` 中的 generic `restore:check` 可能略過，必須讀取 log，不能把 exit 0
   當成還原成功。備份實際還原測試另用隔離合成庫與受保護的
   `test:payroll-backup-db` 入口，依[專用 runbook](PAYROLL_CORRECTION_RELEASE_RUNBOOK.md#驗收證據) 執行。

2. 在分開的正式唯讀檢查中確認平台設定；不要沿用此正式設定執行上面的測試：

- `DATABASE_URL` points to the intended production database
- `SESSION_SECRET` is production-grade
- backup and log paths are outside the workspace
- runtime contract audit has no unexpected failures
- any LINE secrets are complete and current
- the selected backup passes `npm run restore:check:required` (artifact inspection and live counts only, not an actual restore)

3. Review:

- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)
- [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md)
- [PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md)

## Post-Deploy Smoke

Run or verify all of the following immediately after deployment:

```bash
BASE_URL="https://your-app.example.com"

curl "$BASE_URL/api/health"
curl "$BASE_URL/ready"
curl "$BASE_URL/live"
```

Then validate:

- admin login and logout
- employee list
- attendance list
- salary record list
- dashboard backup list
- dashboard operational metrics

If LINE is enabled, also validate:

- LINE login
- LINE callback
- LINE webhook
- LINE clock-in flow

## Canary Monitoring Window

Keep the first public rollout narrow and monitor:

- admin login failure spikes
- invalid webhook signatures
- stale webhook events
- attendance list latency
- salary record list latency
- backup create, restore, and delete failures

Expand traffic only after the canary window stays stable.

## Release Sign-Off

Use this sign-off template in the release note or operator log:

- release candidate:
- operator:
- deployment time:
- `verify:release` result:
- `test:real-db` result:
- backup ID before rollout:
- canary cohort:
- canary observation window:
- go or no-go decision:
