# AES Migration Runbook

## 1. 目的

提供正式 AES 身分證遷移的 operator 標準流程，包含 preflight、execute、post-check、rollback 與證據留存。

## 2. 執行前條件

- 部署中的程式碼必須已包含 `cp6-aes-compatible` 相容讀寫能力
- `DATABASE_URL` 必須指向正確的 PostgreSQL
- 正式 execute 前必須先開啟 `USE_AES_ENCRYPTION=true`
- `ENCRYPTION_KEY` 必須至少 32 字元
- 正式 execute 前必須明確設定 `ENCRYPTION_SALT`
- 遠端資料庫 execute / rollback 必須顯式加上 `--allow-remote`
- 正式 execute 必須提供 operator 身分：
  - `--operator <name>`
  - 或 `AES_MIGRATION_OPERATOR=<name>`
- 需保有最新 restore rehearsal 與 AES rehearsal 證據
- 若缺少 `SESSION_SECRET` / `ENCRYPTION_KEY` / `ENCRYPTION_SALT`，可先執行 `npm run secrets:generate`

## 3. Preflight

依序執行：

```bash
npm run aes:inspect
ENCRYPTION_KEY=... npm run aes:report
ENCRYPTION_KEY=... npm run aes:snapshot
ENCRYPTION_KEY=... npm run aes:rehearse
npm run restore:rehearse
USE_AES_ENCRYPTION=true ENCRYPTION_KEY=... ENCRYPTION_SALT=... npm run aes:status
USE_AES_ENCRYPTION=true ENCRYPTION_KEY=... ENCRYPTION_SALT=... npm run aes:ready
```

`aes:ready` 必須為綠燈，才允許進入正式 execute。

## 4. Operator 證據留存

在 execute 前，至少記錄：

- operator
- 執行時間
- target database host / database name
- 是否使用 `--allow-remote`
- 最新 dry-run report path
- 最新 snapshot report path
- 最新 rehearsal report path
- 最新 restore rehearsal report path
- `aes:ready` status report path

所有報表預設寫入：

- `backups/aes-migration/reports/`
- `backups/restore-rehearsal/reports/`

## 5. 正式 Execute

1. 確認目前 window 內沒有其他資料修復或 restore 作業
2. 執行：

```bash
USE_AES_ENCRYPTION=true \
ENCRYPTION_KEY=... \
ENCRYPTION_SALT=... \
AES_MIGRATION_OPERATOR=ops-window \
npm run aes:migrate -- --allow-remote
```

3. 保留 execute 當下輸出的：
   - snapshot path
   - execute-plan report path
   - migration complete summary
   - operator / target database / remote approval metadata

## 6. Post-check

執行：

```bash
npm run aes:inspect
USE_AES_ENCRYPTION=true ENCRYPTION_KEY=... ENCRYPTION_SALT=... npm run aes:status
npm run test:real-db
npm run verify:ops
```

必須確認：

- `aes:inspect` 顯示 `toMigrate=0`
- `aes:status` 顯示 live analysis 已與最新 evidence 對齊
- `test:real-db` 與 `verify:ops` 維持綠燈
- 條碼掃描、員工列表、管理員員工 API 正常

## 7. Rollback

若 execute 後驗證失敗，依序執行：

```bash
npm run aes:rollback -- --allow-remote
npm run aes:inspect
npm run restore:check
npm run verify:ops
```

若 rollback 後仍異常，使用最近一次 manual backup 走 restore runbook，再回切相對應 checkpoint。

## 8. 關帳條件

本輪 AES 正式遷移可視為完成，至少需同時滿足：

- `aes:migrate` 完成
- `aes:inspect` 顯示無剩餘 migration candidates
- `aes:status` 與 post-check 綠燈
- `USE_AES_ENCRYPTION=true`、`ENCRYPTION_SALT`、operator metadata、remote approval 已納入證據
- rollback 命令已確認可用
- operator 證據已留存
