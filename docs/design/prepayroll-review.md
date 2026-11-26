# 月結前檢查（設計草案，尚未實作、尚未部署）

## 目的
每月 1 日自動月結前，先檢查上個月是否有：
1. 國定假日（含連假）
2. 颱風假／停班停課
3. 週六加班

若有疑點但系統沒有對應標記，先寄一封通知信給負責人本人（僅 `SALARY_AUTOMATION_EMAIL_TO`，須設為單一收件人），
並暫停當月月結，等人工確認後才產生薪資。

## 觸發方式
- main 在 Cloud Run 模式下 `areBackgroundServicesEnabled()` 回傳 false，
  所以 PR #131 的每小時排程與 28 日提醒信在 Cloud Run 上都不會跑。
- 改由 Cloud Scheduler 打 `POST /api/salary-automation/cron-tick`（分支 `claude/cloudrun-cron-tick`），
  排程 `20 1,7 1 * *`（Asia/Taipei）。本設計需要把該分支 rebase 到 main。
- cron-tick 流程：`syncHolidaysBeforePayroll` → **月結前檢查** → 月結。

## 檢查內容（對象：上個月）
| 項目 | 資料來源 | 疑點條件 |
|---|---|---|
| 國定假日 | `shared/taiwanStatutoryHolidays.ts`（PR #131） | 假日當天有人打卡但沒有 `worked` 標記；假日沒有任何標記 |
| 連假 | 同上，再加週末 | 連續 3 天以上不上班的區間，列出並檢查前後是否有異常打卡或缺標 |
| 颱風假／停班 | 平日無人打卡且無標記（沿用 `buildHolidayReminder` 的 `unmarkedNoClockInDates`）；官方來源待定 | 平日全公司無打卡、也沒有 `typhoon_leave`／`temporary_stop_work_and_classes` 標記 |
| 週六加班 | 打卡紀錄（`isRealWorkRecord`） | 週六有實際打卡（目前沒有「週六加班」標記類型，見待決事項） |

## 暫停與恢復
- 新增資料表 `payroll_reviews`（month, status: pending/confirmed, findings, notified_at, confirmed_at, confirmed_by）。
  Cloud Run 會縮到 0，記憶體裡的狀態不可靠，所以要存 DB。
- 有疑點：寫入 `pending`、寄信一次、cron-tick 回 `{ran:false, reason:'awaiting_review', target}`。
- 07:20 備援 tick 看到 `pending` 且已寄過信 → 不重寄、不月結。
- 無疑點：直接月結（與現在相同）。
- 恢復：管理頁按「確認無誤，執行月結」→ 標記 `confirmed` 並立刻執行當月月結（因為 cron 只在 1 日跑兩次）。

## 待決事項
1. 颱風假官方資料：行政院人事行政總處停班停課資訊，政府開放資料平台上可能有資料集，
   但格式、是否保留歷史日期尚未確認。沒有可靠歷史資料前，先用「平日無人打卡」推測。
2. 週六加班「已標注」的定義：薪資計算目前不分週六，週六打卡照一般日算每日加班。
   要改成「有週六打卡就列出來請人確認」，還是新增一個週六加班標記？
3. 連假是否要包含政府調整放假（PR #131 刻意不含）。
4. 是否同意暫停月結；確認後立即執行，或等下次排程。
5. main 已比 Zeabur 線上版（af8cfc4）多 27 個 commit（含 LIFF ID、Resend、#119），部署 main 是另一個決定。
