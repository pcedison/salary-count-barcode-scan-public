# 月結前檢查（已實作於 `claude/cloudrun-release`，尚未部署）

實作：`server/services/prepayrollReview.ts`（檢查規則與信件內容）、`server/runtime/prepayroll-review.ts`（暫停／寄信）、
`server/routes/salaryAutomation.routes.ts`（`GET /api/salary-automation/reviews/pending`、`POST /api/salary-automation/reviews/confirm`）、
`client/src/components/PayrollReviewNotice.tsx`（確認按鈕）。設定與部署步驟見 `docs/CONFIGURATION.md`。

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
| 平日缺勤（逐位員工） | 打卡紀錄＋假日設定 | 週一到週五、不是國定假日，某員工沒有實際打卡、也沒有任何假別標記 → 可能是颱風假、豪雨假、病假（病假要有就診單佐證）或漏打卡。全公司都沒打卡的日子另外標成「可能是天災停班」 |
| 非平日出勤（逐位員工） | 打卡紀錄（`isRealWorkRecord`） | 週六、週日或國定假日，某員工有實際打卡但沒有 `worked` 標記 → 假日出勤（週六打卡現在會自動標成「假日出勤」，這裡抓的是手動改掉或舊資料） |

## 暫停與恢復
- 新增資料表 `payroll_reviews`（month, status: pending/confirmed, findings, notified_at, confirmed_at, confirmed_by）。
  Cloud Run 會縮到 0，記憶體裡的狀態不可靠，所以要存 DB。
- 有疑點：寫入 `pending`、寄信一次、cron-tick 回 `{ran:false, reason:'awaiting_review', target}`。
- 07:20 備援 tick 看到 `pending` 且已寄過信 → 不重寄、不月結。
- 無疑點：直接月結（與現在相同）。
- 恢復：管理頁按「確認無誤，執行月結」→ 標記 `confirmed` 並立刻執行當月月結（因為 cron 只在 1 日跑兩次）。

## 待決事項
1. 颱風假官方資料：尚未找到保留歷史日期的官方資料集，先用「平日沒打卡」逐位員工推測。
   國定假日已改成自動抓人事總處辦公日曆表（分支 `claude/holiday-calendar-sync`）。
2. 週六加班「已標注」的定義：薪資計算目前不分週六，週六打卡照一般日算每日加班。
   要改成「有週六打卡就列出來請人確認」，還是新增一個週六加班標記？
3. 連假是否要包含政府調整放假（PR #131 刻意不含）。
4. 是否同意暫停月結；確認後立即執行，或等下次排程。
5. main 已比 Zeabur 線上版（af8cfc4）多 27 個 commit（含 LIFF ID、Resend、#119），部署 main 是另一個決定。
