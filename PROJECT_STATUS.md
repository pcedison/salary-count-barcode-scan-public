# LINE 考勤 Cloud Run 搬遷狀態

更新日期：2026-10-29。Canonical repo 為 `pcedison/salary-count-barcode-scan-public`，主分支 `main`。

- 實作與測試使用獨立 Git worktree；文件指令以 repository 根目錄為工作目錄。
- 工作分支：`codex/attendance-cloudrun-20261029`；基準 `91cfc847b5e4c26504f05690106b5d6311463008`。本輪交付範圍為 commit、push 功能分支及 PR；不合併或部署，實際 commit／CI 狀態以 PR 紀錄為準。
- 方向：Cloud Run 常駐 service 作 LINE 出勤主機，Railway 暫時排除。程式與本機容器驗證不代表正式平台已更新。
- 新打卡契約：明確確認、事件 UUID、持久回執、員工交易鎖、狀態版本、伺服器時間基準。初始化／重載／返回不自動寫入；未知結果先核對原事件。
- Cloud Run 必須真實持久掛載、固定 Secret Manager 引用、完整 TLS 驗證、最少 1 instance 與常駐 CPU。所有自動背景作業先停用，保留必要一次性業務設定載入。
- 既有正式資料、正式 `.env`、舊加密備份與 Zeabur 服務均未操作。本次資料庫、員工、瀏覽器 session 及通知均為隔離測試資料。

操作與切換前提見 [Cloud Run 操作手冊](docs/CLOUD_RUN_PRIMARY_RUNBOOK.md)。實際測試及限制見 [本次驗證紀錄](docs/CLOUD_RUN_IMPLEMENTATION_VERIFICATION_20261029.md)。歷史盤點見 [2026-10-28 搬遷規劃](docs/ATTENDANCE_MIGRATION_RELIABILITY_PLAN_20261028.md)，其中部署觀察與測試數屬當時狀態。
